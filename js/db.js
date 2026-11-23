/**
 * VOYN IndexedDB Manager
 * Yerel veri saklama: mesajlar, konuşmalar, kullanıcılar, medya blob'ları
 */

class VoynDB {
  constructor() {
    this.db = null;
    this.dbName = VOYN_CONFIG.DB_NAME;
    this.dbVersion = VOYN_CONFIG.DB_VERSION;
  }

  /**
   * Veritabanını aç/oluştur
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // --- messages store ---
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('by_conversation', 'conversationId', { unique: false });
          msgStore.createIndex('by_sender', 'fromUserId', { unique: false });
          msgStore.createIndex('by_created_at', 'createdAt', { unique: false });
          msgStore.createIndex('by_status', 'status', { unique: false });
        }

        // --- conversations store ---
        if (!db.objectStoreNames.contains('conversations')) {
          const convStore = db.createObjectStore('conversations', { keyPath: 'id' });
          convStore.createIndex('by_updated_at', 'updatedAt', { unique: false });
          convStore.createIndex('by_participant', 'participantIds', { unique: false, multiEntry: true });
        }

        // --- users store ---
        if (!db.objectStoreNames.contains('users')) {
          const userStore = db.createObjectStore('users', { keyPath: 'id' });
          userStore.createIndex('by_username', 'username', { unique: true });
          userStore.createIndex('by_device_id', 'deviceId', { unique: false });
        }

        // --- media store (blob saklama) ---
        if (!db.objectStoreNames.contains('media')) {
          const mediaStore = db.createObjectStore('media', { keyPath: 'id' });
          mediaStore.createIndex('by_message', 'messageId', { unique: false });
          mediaStore.createIndex('by_type', 'type', { unique: false });
          mediaStore.createIndex('by_created_at', 'createdAt', { unique: false });
        }

        // --- offline_queue store ---
        if (!db.objectStoreNames.contains('offline_queue')) {
          const queueStore = db.createObjectStore('offline_queue', {
            keyPath: 'id',
            autoIncrement: true,
          });
          queueStore.createIndex('by_created_at', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;

        this.db.onerror = (e) => {
          console.error('[VoynDB] Database error:', e.target.error);
        };

        console.log('[VoynDB] Initialized');
        resolve(this);
      };

      request.onerror = (event) => {
        console.error('[VoynDB] Open error:', event.target.error);
        reject(event.target.error);
      };

      request.onblocked = () => {
        console.warn('[VoynDB] Database blocked — close other tabs');
      };
    });
  }

  // ─── Generic helpers ────────────────────────────────────────────────────────

  _tx(storeNames, mode = 'readonly') {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return this.db.transaction(names, mode);
  }

  _store(storeName, mode = 'readonly') {
    return this._tx(storeName, mode).objectStore(storeName);
  }

  _promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  _getAll(storeName, indexName, query) {
    return new Promise((resolve, reject) => {
      const store = this._store(storeName);
      const source = indexName ? store.index(indexName) : store;
      const req = query !== undefined ? source.getAll(query) : source.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ─── Messages ────────────────────────────────────────────────────────────────

  /**
   * Mesajı kaydet (yeni veya güncelle)
   */
  async saveMessage(message) {
    if (!message.id) throw new Error('Message must have an id');
    if (!message.createdAt) message.createdAt = new Date().toISOString();
    const store = this._store('messages', 'readwrite');
    return this._promisify(store.put(message));
  }

  /**
   * Birden fazla mesajı toplu kaydet
   */
  async saveMessages(messages) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('messages', 'readwrite');
      const store = tx.objectStore('messages');
      let count = 0;

      messages.forEach((msg) => {
        if (!msg.createdAt) msg.createdAt = new Date().toISOString();
        const req = store.put(msg);
        req.onsuccess = () => { count++; };
        req.onerror = () => reject(req.error);
      });

      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Konuşmaya ait mesajları getir (sayfalı)
   */
  async getMessages(conversationId, { limit = VOYN_CONFIG.MESSAGES_PER_PAGE, before = null } = {}) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('messages', 'readonly');
      const index = tx.objectStore('messages').index('by_conversation');
      const results = [];

      const req = index.openCursor(IDBKeyRange.only(conversationId), 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || results.length >= limit) {
          resolve(results.reverse());
          return;
        }
        const msg = cursor.value;
        if (before && msg.createdAt >= before) {
          cursor.continue();
          return;
        }
        results.push(msg);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Tek mesaj getir
   */
  async getMessage(id) {
    return this._promisify(this._store('messages').get(id));
  }

  /**
   * Mesaj durumunu güncelle (sent / delivered / read)
   */
  async updateMessageStatus(messageId, status) {
    const tx = this._tx('messages', 'readwrite');
    const store = tx.objectStore('messages');

    return new Promise((resolve, reject) => {
      const getReq = store.get(messageId);
      getReq.onsuccess = () => {
        const msg = getReq.result;
        if (!msg) { resolve(null); return; }
        msg.status = status;
        if (status === 'delivered') msg.deliveredAt = new Date().toISOString();
        if (status === 'read') msg.readAt = new Date().toISOString();
        const putReq = store.put(msg);
        putReq.onsuccess = () => resolve(msg);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * Konuşmadaki okunmamış mesaj sayısını döndür
   */
  async getUnreadCount(conversationId, myUserId) {
    const messages = await this.getMessages(conversationId, { limit: 999 });
    return messages.filter(
      (m) => m.fromUserId !== myUserId && m.status !== 'read'
    ).length;
  }

  /**
   * Mesajı sil
   */
  async deleteMessage(messageId) {
    return this._promisify(this._store('messages', 'readwrite').delete(messageId));
  }

  // ─── Conversations ────────────────────────────────────────────────────────

  /**
   * Konuşmayı kaydet/güncelle
   */
  async saveConversation(conversation) {
    if (!conversation.id) throw new Error('Conversation must have an id');
    if (!conversation.updatedAt) conversation.updatedAt = new Date().toISOString();
    return this._promisify(this._store('conversations', 'readwrite').put(conversation));
  }

  /**
   * Tekil konuşma getir
   */
  async getConversation(id) {
    return this._promisify(this._store('conversations').get(id));
  }

  /**
   * Tüm konuşmaları getir (en son güncellenen önce)
   */
  async getAllConversations() {
    return new Promise((resolve, reject) => {
      const tx = this._tx('conversations', 'readonly');
      const index = tx.objectStore('conversations').index('by_updated_at');
      const results = [];

      const req = index.openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(results); return; }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Konuşmanın son mesajını ve okunmamış sayısını güncelle
   */
  async updateConversationMeta(conversationId, lastMessage, unreadDelta = 0) {
    const tx = this._tx('conversations', 'readwrite');
    const store = tx.objectStore('conversations');

    return new Promise((resolve, reject) => {
      const getReq = store.get(conversationId);
      getReq.onsuccess = () => {
        const conv = getReq.result;
        if (!conv) { resolve(null); return; }
        conv.lastMessage = lastMessage;
        conv.updatedAt = new Date().toISOString();
        conv.unreadCount = Math.max(0, (conv.unreadCount || 0) + unreadDelta);
        const putReq = store.put(conv);
        putReq.onsuccess = () => resolve(conv);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * Konuşmanın okunmamış sayısını sıfırla
   */
  async resetUnreadCount(conversationId) {
    return this.updateConversationMeta(conversationId, undefined, 0).then(async () => {
      const conv = await this.getConversation(conversationId);
      if (conv) { conv.unreadCount = 0; await this.saveConversation(conv); }
    });
  }

  /**
   * Konuşmayı sil
   */
  async deleteConversation(conversationId) {
    return this._promisify(this._store('conversations', 'readwrite').delete(conversationId));
  }

  // ─── Users ───────────────────────────────────────────────────────────────

  /**
   * Kullanıcıyı kaydet/güncelle
   */
  async saveUser(user) {
    if (!user.id) throw new Error('User must have an id');
    return this._promisify(this._store('users', 'readwrite').put(user));
  }

  /**
   * ID ile kullanıcı getir
   */
  async getUser(id) {
    return this._promisify(this._store('users').get(id));
  }

  /**
   * Kullanıcı adı ile kullanıcı getir
   */
  async getUserByUsername(username) {
    return this._promisify(this._store('users').index('by_username').get(username));
  }

  /**
   * Tüm kullanıcıları getir
   */
  async getAllUsers() {
    return this._getAll('users');
  }

  // ─── Media (Blob) ────────────────────────────────────────────────────────

  /**
   * Medya blob kaydet
   * @param {string} id - benzersiz kimlik
   * @param {Blob} blob - medya verisi
   * @param {object} meta - { messageId, type, mimeType, fileName }
   */
  async saveMedia(id, blob, meta = {}) {
    const record = {
      id,
      blob,
      messageId: meta.messageId || null,
      type: meta.type || 'file',
      mimeType: meta.mimeType || blob.type || 'application/octet-stream',
      fileName: meta.fileName || id,
      size: blob.size,
      createdAt: new Date().toISOString(),
    };
    return this._promisify(this._store('media', 'readwrite').put(record));
  }

  /**
   * Medya blob getir
   */
  async getMedia(id) {
    return this._promisify(this._store('media').get(id));
  }

  /**
   * Mesaja ait tüm medya blob'larını getir
   */
  async getMediaByMessage(messageId) {
    return this._getAll('media', 'by_message', IDBKeyRange.only(messageId));
  }

  /**
   * Medya blob sil
   */
  async deleteMedia(id) {
    return this._promisify(this._store('media', 'readwrite').delete(id));
  }

  /**
   * Eski medya blob'larını temizle (n günden eski)
   */
  async pruneOldMedia(days = 7) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return new Promise((resolve, reject) => {
      const tx = this._tx('media', 'readwrite');
      const index = tx.objectStore('media').index('by_created_at');
      const range = IDBKeyRange.upperBound(cutoff);
      let deleted = 0;

      const req = index.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(deleted); return; }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ─── Offline Queue ───────────────────────────────────────────────────────

  /**
   * Çevrimdışı mesajı kuyruğa ekle
   */
  async enqueueOffline(payload) {
    const record = { ...payload, createdAt: new Date().toISOString() };
    return this._promisify(this._store('offline_queue', 'readwrite').add(record));
  }

  /**
   * Kuyruktan tüm bekleyen mesajları getir
   */
  async getOfflineQueue() {
    return this._getAll('offline_queue');
  }

  /**
   * Kuyruktan mesaj sil (başarıyla gönderildi)
   */
  async dequeueOffline(id) {
    return this._promisify(this._store('offline_queue', 'readwrite').delete(id));
  }

  /**
   * Tüm offline kuyruğu temizle
   */
  async clearOfflineQueue() {
    return this._promisify(this._store('offline_queue', 'readwrite').clear());
  }

  // ─── Utility ────────────────────────────────────────────────────────────

  /**
   * Tüm store'ları temizle (çıkış yapılınca)
   */
  async clearAll() {
    const stores = ['messages', 'conversations', 'users', 'media', 'offline_queue'];
    return Promise.all(
      stores.map((name) => this._promisify(this._store(name, 'readwrite').clear()))
    );
  }

  /**
   * Veritabanı bağlantısını kapat
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
