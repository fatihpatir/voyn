/**
 * VOYN Messaging — Mesajlaşma sistemi
 * Supabase Realtime + IndexedDB + MediaRecorder
 */

class VoynMessaging {
  constructor(supabaseClient, db, auth) {
    this.supabase = supabaseClient;
    this.db = db;
    this.auth = auth;

    this._channel = null;           // Supabase Realtime kanalı
    this._mediaRecorder = null;     // Sesli mesaj kaydedici
    this._audioChunks = [];
    this._onMessageCallbacks = [];
    this._onStatusCallbacks = [];
    this._isOnline = navigator.onLine;

    // Çevrimiçi/çevrimdışı izle
    window.addEventListener('online', () => this._onNetworkChange(true));
    window.addEventListener('offline', () => this._onNetworkChange(false));
  }

  // ─── Realtime ────────────────────────────────────────────────────────────

  /**
   * Supabase Realtime kanalına abone ol
   */
  async startListening() {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Oturum açılmamış');

    // Önceki kanalı kapat
    if (this._channel) {
      await this.supabase.removeChannel(this._channel);
    }

    this._channel = this.supabase
      .channel(`messages:${user.id}`)
      // Kendine gelen yeni mesajlar
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `to_user_id=eq.${user.id}`,
        },
        (payload) => this._handleIncoming(payload.new)
      )
      // Mesaj durumu güncellemeleri (teslim/okundu)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `from_user_id=eq.${user.id}`,
        },
        (payload) => this._handleStatusUpdate(payload.new)
      )
      .subscribe((status) => {
        console.log('[VoynMessaging] Realtime status:', status);
      });
  }

  async stopListening() {
    if (this._channel) {
      await this.supabase.removeChannel(this._channel);
      this._channel = null;
    }
  }

  // ─── Send Message ─────────────────────────────────────────────────────────

  /**
   * Mesaj gönder
   * @param {string} toUserId - Alıcı kullanıcı ID'si
   * @param {string|File|Blob} content - Mesaj içeriği
   * @param {string} type - 'text' | 'image' | 'video' | 'file' | 'voice'
   * @param {object} extra - Ek metadata
   */
  async sendMessage(toUserId, content, type = VOYN_CONFIG.MESSAGE_TYPES.TEXT, extra = {}) {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Oturum açılmamış');

    const messageId = crypto.randomUUID();
    let messagePayload = {
      id: messageId,
      from_user_id: user.id,
      to_user_id: toUserId,
      type,
      status: 'sending',
      created_at: new Date().toISOString(),
      conversation_id: this._getConversationId(user.id, toUserId),
      ...extra,
    };

    // Medya dosyaları için yükle
    if (type !== VOYN_CONFIG.MESSAGE_TYPES.TEXT) {
      const file = content instanceof File || content instanceof Blob ? content : null;
      if (!file) throw new Error('Medya tipi için File/Blob gerekli');
      if (file.size > VOYN_CONFIG.MAX_FILE_SIZE) {
        throw new Error('Dosya boyutu 50 MB\'ı aşamaz');
      }

      // Önce IndexedDB'ye blob kaydet (çevrimdışı destek)
      const mediaId = crypto.randomUUID();
      await this.db.saveMedia(mediaId, file, {
        messageId,
        type,
        mimeType: file.type,
        fileName: file.name || `${type}_${Date.now()}`,
      });

      messagePayload.mediaId = mediaId;
      messagePayload.fileName = file.name || null;
      messagePayload.fileSize = file.size;
      messagePayload.mimeType = file.type;
    } else {
      messagePayload.content = content;
    }

    // Yerel mesajı hemen kaydet (optimistic UI)
    await this.db.saveMessage({
      id: messageId,
      conversationId: messagePayload.conversation_id,
      fromUserId: user.id,
      toUserId,
      type,
      content: type === VOYN_CONFIG.MESSAGE_TYPES.TEXT ? content : null,
      mediaId: messagePayload.mediaId || null,
      fileName: messagePayload.fileName || null,
      fileSize: messagePayload.fileSize || null,
      mimeType: messagePayload.mimeType || null,
      status: 'sending',
      createdAt: messagePayload.created_at,
    });

    // Konuşmayı güncelle
    await this._upsertConversation(toUserId, messagePayload);

    if (!this._isOnline) {
      // Çevrimdışı kuyruğa ekle
      await this.db.enqueueOffline({ messagePayload, type, toUserId });
      await this.db.updateMessageStatus(messageId, 'queued');
      return { id: messageId, status: 'queued' };
    }

    return this._deliverMessage(messagePayload, type, content);
  }

  /**
   * Mesajı sunucuya gönder (medya varsa yükle)
   */
  async _deliverMessage(messagePayload, type, rawContent) {
    try {
      let url = null;

      // Medya yükle
      if (type !== VOYN_CONFIG.MESSAGE_TYPES.TEXT) {
        const media = await this.db.getMedia(messagePayload.mediaId);
        if (media) {
          url = await this._uploadMedia(media.blob, media.mimeType, media.fileName, type);
          messagePayload.url = url;
        }
      }

      // Supabase'e mesajı ekle
      const dbRecord = {
        id: messagePayload.id,
        from_user_id: messagePayload.from_user_id,
        to_user_id: messagePayload.to_user_id,
        conversation_id: messagePayload.conversation_id,
        type: messagePayload.type,
        content: type === VOYN_CONFIG.MESSAGE_TYPES.TEXT ? rawContent : null,
        url: url || null,
        file_name: messagePayload.fileName || null,
        file_size: messagePayload.fileSize || null,
        mime_type: messagePayload.mimeType || null,
        status: 'sent',
        created_at: messagePayload.created_at,
      };

      const { error } = await this.supabase.from('messages').insert(dbRecord);
      if (error) throw error;

      // Yerel durumu güncelle
      await this.db.updateMessageStatus(messagePayload.id, 'sent');
      this._emitStatus(messagePayload.id, 'sent');

      return { id: messagePayload.id, status: 'sent', url };
    } catch (err) {
      console.error('[VoynMessaging] Send error:', err);
      await this.db.updateMessageStatus(messagePayload.id, 'failed');
      this._emitStatus(messagePayload.id, 'failed');
      throw err;
    }
  }

  // ─── File Upload ─────────────────────────────────────────────────────────

  /**
   * Supabase Storage'a dosya yükle
   */
  async _uploadMedia(blob, mimeType, fileName, type) {
    const user = this.auth.getCurrentUser();
    const bucket = type === VOYN_CONFIG.MESSAGE_TYPES.VOICE
      ? VOYN_CONFIG.STORAGE_BUCKETS.VOICE
      : VOYN_CONFIG.STORAGE_BUCKETS.MEDIA;

    const ext = fileName ? fileName.split('.').pop() : mimeType.split('/')[1] || 'bin';
    const path = `${user.id}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;

    const { error } = await this.supabase.storage
      .from(bucket)
      .upload(path, blob, { contentType: mimeType, upsert: false });

    if (error) throw error;

    const { data } = this.supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  // ─── Voice Message ───────────────────────────────────────────────────────

  /**
   * Sesli mesaj kaydını başlat
   */
  async startVoiceRecording() {
    if (this._mediaRecorder && this._mediaRecorder.state === 'recording') {
      throw new Error('Kayıt zaten devam ediyor');
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._audioChunks = [];

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/ogg;codecs=opus';

    this._mediaRecorder = new MediaRecorder(stream, { mimeType });

    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._audioChunks.push(e.data);
    };

    this._mediaRecorder.start(250); // 250ms timeslice
    return this._mediaRecorder;
  }

  /**
   * Sesli mesaj kaydını durdur ve Blob döndür
   * @returns {Promise<Blob>}
   */
  stopVoiceRecording() {
    return new Promise((resolve, reject) => {
      if (!this._mediaRecorder || this._mediaRecorder.state === 'inactive') {
        reject(new Error('Aktif kayıt yok'));
        return;
      }

      this._mediaRecorder.onstop = () => {
        const mimeType = this._mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(this._audioChunks, { type: mimeType });

        // Ses akışını kapat
        this._mediaRecorder.stream.getTracks().forEach((t) => t.stop());
        this._audioChunks = [];
        resolve(blob);
      };

      this._mediaRecorder.onerror = (e) => reject(e.error);
      this._mediaRecorder.stop();
    });
  }

  /**
   * Sesli mesaj gönder
   * @param {string} toUserId
   * @param {Blob} audioBlob
   */
  async sendVoiceMessage(toUserId, audioBlob) {
    const fileName = `voice_${Date.now()}.webm`;
    const file = new File([audioBlob], fileName, { type: audioBlob.type });
    return this.sendMessage(toUserId, file, VOYN_CONFIG.MESSAGE_TYPES.VOICE, { fileName });
  }

  // ─── Delivery / Read Receipts ────────────────────────────────────────────

  /**
   * Teslim bildirimi gönder
   */
  async markAsDelivered(messageId) {
    const { error } = await this.supabase
      .from('messages')
      .update({ status: 'delivered', delivered_at: new Date().toISOString() })
      .eq('id', messageId);

    if (error) console.warn('[VoynMessaging] markAsDelivered error:', error);
    await this.db.updateMessageStatus(messageId, 'delivered');
    this._emitStatus(messageId, 'delivered');
  }

  /**
   * Okundu bildirimi gönder
   */
  async markAsRead(messageId) {
    const { error } = await this.supabase
      .from('messages')
      .update({ status: 'read', read_at: new Date().toISOString() })
      .eq('id', messageId);

    if (error) console.warn('[VoynMessaging] markAsRead error:', error);
    await this.db.updateMessageStatus(messageId, 'read');
    this._emitStatus(messageId, 'read');
  }

  /**
   * Konuşmadaki tüm mesajları okundu yap
   */
  async markConversationRead(conversationId) {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    const { error } = await this.supabase
      .from('messages')
      .update({ status: 'read', read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('to_user_id', user.id)
      .neq('status', 'read');

    if (error) console.warn('[VoynMessaging] markConversationRead error:', error);

    // IndexedDB'yi güncelle
    const messages = await this.db.getMessages(conversationId, { limit: 999 });
    await Promise.all(
      messages
        .filter((m) => m.toUserId === user.id && m.status !== 'read')
        .map((m) => this.db.updateMessageStatus(m.id, 'read'))
    );

    await this.db.resetUnreadCount(conversationId);
  }

  // ─── Offline queue flush ──────────────────────────────────────────────────

  /**
   * Çevrimiçine geçince sıraya alınmış mesajları gönder
   */
  async flushOfflineQueue() {
    const queue = await this.db.getOfflineQueue();
    if (queue.length === 0) return;

    console.log(`[VoynMessaging] Flushing ${queue.length} queued messages`);

    for (const item of queue) {
      try {
        const { messagePayload, type, toUserId } = item;
        // Medya blob'u IndexedDB'den al
        let rawContent = messagePayload.content || null;
        if (type !== VOYN_CONFIG.MESSAGE_TYPES.TEXT && messagePayload.mediaId) {
          const media = await this.db.getMedia(messagePayload.mediaId);
          rawContent = media ? media.blob : null;
        }

        await this._deliverMessage(messagePayload, type, rawContent);
        await this.db.dequeueOffline(item.id);
      } catch (err) {
        console.error('[VoynMessaging] Queue flush error for item', item.id, err);
      }
    }
  }

  // ─── Incoming message handler ─────────────────────────────────────────────

  async _handleIncoming(raw) {
    const user = this.auth.getCurrentUser();

    const message = {
      id: raw.id,
      conversationId: raw.conversation_id,
      fromUserId: raw.from_user_id,
      toUserId: raw.to_user_id,
      type: raw.type,
      content: raw.content || null,
      url: raw.url || null,
      fileName: raw.file_name || null,
      fileSize: raw.file_size || null,
      mimeType: raw.mime_type || null,
      status: 'delivered',
      createdAt: raw.created_at,
    };

    // IndexedDB'ye kaydet
    await this.db.saveMessage(message);

    // Konuşmayı güncelle
    await this._upsertConversation(raw.from_user_id, raw, true);

    // Teslim bildirimi gönder
    await this.markAsDelivered(raw.id);

    // Callback'leri çağır
    this._onMessageCallbacks.forEach((cb) => cb(message));
  }

  async _handleStatusUpdate(raw) {
    await this.db.updateMessageStatus(raw.id, raw.status);
    this._emitStatus(raw.id, raw.status);
  }

  // ─── Conversation helpers ─────────────────────────────────────────────────

  /**
   * İki kullanıcı ID'sinden deterministik konuşma ID'si üret
   */
  _getConversationId(userA, userB) {
    const sorted = [userA, userB].sort();
    return `${sorted[0]}_${sorted[1]}`;
  }

  async _upsertConversation(otherUserId, message, incoming = false) {
    const user = this.auth.getCurrentUser();
    const conversationId = this._getConversationId(user.id, otherUserId);

    const existing = await this.db.getConversation(conversationId);
    const conv = existing || {
      id: conversationId,
      participantIds: [user.id, otherUserId],
      unreadCount: 0,
      createdAt: new Date().toISOString(),
    };

    conv.lastMessage = {
      id: message.id || message.id,
      type: message.type,
      content: message.content || null,
      fromUserId: message.from_user_id || message.fromUserId,
      createdAt: message.created_at || message.createdAt,
    };
    conv.updatedAt = new Date().toISOString();
    if (incoming) conv.unreadCount = (conv.unreadCount || 0) + 1;

    await this.db.saveConversation(conv);
  }

  // ─── Supabase'den geçmiş mesaj yükle ─────────────────────────────────────

  /**
   * Sunucudan mesaj geçmişini yükle ve IndexedDB'ye kaydet
   */
  async loadHistory(conversationId, before = null) {
    const user = this.auth.getCurrentUser();
    if (!user) return [];

    let query = this.supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(VOYN_CONFIG.MESSAGES_PER_PAGE);

    if (before) {
      query = query.lt('created_at', before);
    }

    const { data, error } = await query;
    if (error) throw error;

    const messages = (data || []).map((raw) => ({
      id: raw.id,
      conversationId: raw.conversation_id,
      fromUserId: raw.from_user_id,
      toUserId: raw.to_user_id,
      type: raw.type,
      content: raw.content || null,
      url: raw.url || null,
      fileName: raw.file_name || null,
      fileSize: raw.file_size || null,
      mimeType: raw.mime_type || null,
      status: raw.status,
      createdAt: raw.created_at,
      deliveredAt: raw.delivered_at || null,
      readAt: raw.read_at || null,
    }));

    if (messages.length) {
      await this.db.saveMessages(messages);
    }

    return messages.reverse();
  }

  // ─── Event emitters ───────────────────────────────────────────────────────

  onMessage(callback) {
    this._onMessageCallbacks.push(callback);
    return () => {
      this._onMessageCallbacks = this._onMessageCallbacks.filter((c) => c !== callback);
    };
  }

  onStatusChange(callback) {
    this._onStatusCallbacks.push(callback);
    return () => {
      this._onStatusCallbacks = this._onStatusCallbacks.filter((c) => c !== callback);
    };
  }

  _emitStatus(messageId, status) {
    this._onStatusCallbacks.forEach((cb) => cb({ messageId, status }));
  }

  // ─── Network ──────────────────────────────────────────────────────────────

  _onNetworkChange(isOnline) {
    this._isOnline = isOnline;
    if (isOnline) {
      console.log('[VoynMessaging] Back online — flushing queue');
      this.flushOfflineQueue().catch(console.error);
      // Realtime kanalını yeniden başlat
      this.startListening().catch(console.error);
    }
  }
}
