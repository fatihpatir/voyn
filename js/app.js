/**
 * VOYN App — Ana uygulama kontrolcüsü
 * Tüm modülleri yönetir, ekran navigasyonunu ve UI güncelleme mantığını içerir.
 */

class VoynApp {
  constructor() {
    // Modül örnekleri (init() sonrası dolu olur)
    this.db = null;
    this.auth = null;
    this.messaging = null;
    this.friends = null;
    this.webrtc = null;         // js/webrtc.js tarafından sağlanır
    this.push = null;           // sw.js tarafından yönetilir

    // UI durumu
    this._activeScreen = null;
    this._activeConversationId = null;
    this._activeContactId = null;
    this._theme = localStorage.getItem('voyn_theme') || 'dark';
    this._toastTimer = null;

    // Supabase istemcisi (config değerlerinden)
    this.supabase = null;
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────

  async init() {
    try {
      // Supabase istemcisi oluştur
      this.supabase = supabase.createClient(
        VOYN_CONFIG.SUPABASE_URL,
        VOYN_CONFIG.SUPABASE_ANON_KEY
      );

      // IndexedDB
      this.db = new VoynDB();
      await this.db.init();

      // Auth
      this.auth = new VoynAuth(this.supabase, this.db);

      // Messaging & Friends (auth sonrası)
      this.messaging = new VoynMessaging(this.supabase, this.db, this.auth);
      this.friends = new VoynFriends(this.supabase, this.db, this.auth);

      // WebRTC — opsiyonel (voyn_webrtc global'ı varsa)
      if (typeof VoynWebRTC !== 'undefined') {
        this.webrtc = new VoynWebRTC(this.supabase, this.auth);
      }

      // Tema uygula
      this._applyTheme(this._theme);

      // Olay dinleyicilerini bağla
      this._bindEvents();

      // Otomatik giriş dene
      const user = await this.auth.autoLogin();
      if (user) {
        await this._onLoggedIn(user);
      } else {
        this.showScreen('auth');
      }

      // Service Worker kaydı
      this._registerServiceWorker();

      console.log('[VoynApp] Initialized');
    } catch (err) {
      console.error('[VoynApp] Init error:', err);
      this._showError('Uygulama başlatılırken bir hata oluştu. Sayfayı yenileyin.');
    }
  }

  // ─── Post-login setup ─────────────────────────────────────────────────────

  async _onLoggedIn(user) {
    // Realtime dinlemeyi başlat
    await this.messaging.startListening();

    // Arkadaşları yükle
    await this.friends.init();

    // Varlık heartbeat
    this.auth.startPresenceHeartbeat();

    // Gelen mesaj dinleyicisi
    this.messaging.onMessage((msg) => this._handleIncomingMessage(msg));
    this.messaging.onStatusChange(({ messageId, status }) =>
      this._updateMessageStatusUI(messageId, status)
    );

    // Arkadaşlık isteği dinleyicisi
    this.friends.onFriendRequest((req) => this._handleFriendRequest(req));

    // Presence
    const friendIds = (await this.friends.getFriendsList()).map((f) => f.id);
    if (friendIds.length > 0) {
      this.friends.subscribeToPresence(friendIds);
      this.friends.onPresenceChange((userId, presence) =>
        this._updatePresenceUI(userId, presence)
      );
    }

    // Çevrimdışı kuyruğu boşalt
    await this.messaging.flushOfflineQueue();

    // Ana ekrana geç ve konuşma listesini yükle
    this.showScreen('home');
    await this.renderConversationList();
  }

  // ─── Screen Navigation ────────────────────────────────────────────────────

  /**
   * Ekranı göster
   * @param {'auth'|'home'|'chat'|'call'|'profile'} name
   * @param {object} [params] - ekrana ait veriler
   */
  showScreen(name, params = {}) {
    const screens = document.querySelectorAll('[id^="screen-"]');
    screens.forEach((s) => {
      s.classList.remove('active');
      s.setAttribute('aria-hidden', 'true');
    });

    const target = document.getElementById(`screen-${name}`);
    if (!target) {
      console.warn('[VoynApp] Screen not found:', name);
      return;
    }

    target.classList.add('active');
    target.setAttribute('aria-hidden', 'false');
    this._activeScreen = name;

    // Ekrana özgü setup
    if (name === 'chat' && params.conversationId) {
      this._activeConversationId = params.conversationId;
      this._activeContactId = params.contactId;
      this.renderChatScreen(params.conversationId, params.contact);
    }

    if (name === 'profile') {
      this.renderProfileScreen();
    }

    if (name === 'home') {
      this.renderConversationList();
    }

    // Alt nav aktif durumunu güncelle
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.screen === name);
    });
  }

  hideScreen(name) {
    const target = document.getElementById(`screen-${name}`);
    if (target) {
      target.classList.remove('active');
      target.setAttribute('aria-hidden', 'true');
    }
    if (this._activeScreen === name) this._activeScreen = null;
  }

  // ─── Conversation List ────────────────────────────────────────────────────

  async renderConversationList() {
    const listEl = document.getElementById('conversation-list');
    if (!listEl) return;

    const conversations = await this.db.getAllConversations();
    if (conversations.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">💬</span>
          <p>Henüz konuşma yok</p>
          <p class="empty-hint">Arkadaşlarını ara ve mesaj at!</p>
        </div>`;
      return;
    }

    const user = this.auth.getCurrentUser();

    // Her konuşma için karşı tarafın profilini getir
    const items = await Promise.all(
      conversations.map(async (conv) => {
        const otherId = conv.participantIds.find((id) => id !== user.id);
        const contact = await this.db.getUser(otherId) || { id: otherId, username: 'Bilinmeyen' };
        const friend = this.friends.getFriendById(otherId);
        const isOnline = friend?.isOnline || false;
        return { conv, contact, isOnline };
      })
    );

    listEl.innerHTML = items
      .map(({ conv, contact, isOnline }) => this._conversationItemHTML(conv, contact, isOnline))
      .join('');

    // Konuşma öğelerine tıklama ekle
    listEl.querySelectorAll('.conversation-item').forEach((el) => {
      el.addEventListener('click', () => {
        const { conversationId, contactId } = el.dataset;
        this._openConversation(conversationId, contactId);
      });
    });
  }

  _conversationItemHTML(conv, contact, isOnline) {
    const lastMsg = conv.lastMessage;
    const preview = lastMsg
      ? lastMsg.type === 'text'
        ? this._escapeHtml(lastMsg.content || '')
        : `📎 ${lastMsg.type === 'image' ? 'Fotoğraf' : lastMsg.type === 'voice' ? 'Sesli mesaj' : 'Dosya'}`
      : '';
    const time = lastMsg
      ? this._formatTime(lastMsg.createdAt)
      : '';
    const unread = conv.unreadCount > 0
      ? `<span class="unread-badge">${conv.unreadCount > 99 ? '99+' : conv.unreadCount}</span>`
      : '';
    const avatarLetter = (contact.username || '?')[0].toUpperCase();
    const avatarImg = contact.avatarUrl
      ? `<img src="${this._escapeHtml(contact.avatarUrl)}" alt="${this._escapeHtml(contact.username)}" />`
      : `<span class="avatar-letter">${avatarLetter}</span>`;

    return `
      <div class="conversation-item" data-conversation-id="${conv.id}" data-contact-id="${contact.id}" role="button" tabindex="0">
        <div class="avatar ${isOnline ? 'online' : ''}">
          ${avatarImg}
          ${isOnline ? '<span class="presence-dot"></span>' : ''}
        </div>
        <div class="conv-info">
          <div class="conv-header">
            <span class="conv-name">${this._escapeHtml(contact.username)}</span>
            <span class="conv-time">${time}</span>
          </div>
          <div class="conv-footer">
            <span class="conv-preview">${preview}</span>
            ${unread}
          </div>
        </div>
      </div>`;
  }

  async _openConversation(conversationId, contactId) {
    const contact = await this.db.getUser(contactId);
    this.showScreen('chat', { conversationId, contactId, contact });
  }

  // ─── Chat Screen ──────────────────────────────────────────────────────────

  async renderChatScreen(conversationId, contact) {
    // Başlık
    const headerName = document.getElementById('chat-header-name');
    const headerAvatar = document.getElementById('chat-header-avatar');
    const headerStatus = document.getElementById('chat-header-status');

    if (contact) {
      if (headerName) headerName.textContent = contact.username || 'Kullanıcı';
      if (headerAvatar) {
        headerAvatar.innerHTML = contact.avatarUrl
          ? `<img src="${this._escapeHtml(contact.avatarUrl)}" alt="${this._escapeHtml(contact.username)}" />`
          : `<span class="avatar-letter">${(contact.username || '?')[0].toUpperCase()}</span>`;
      }
      if (headerStatus) {
        const friend = this.friends.getFriendById(contact.id);
        headerStatus.textContent = friend?.isOnline
          ? 'çevrimiçi'
          : friend?.lastSeen
          ? `son görülme: ${this._formatTime(friend.lastSeen)}`
          : '';
      }
    }

    // Yerel mesajları yükle, sonra sunucudan güncelle
    await this.renderMessageList(conversationId);

    // Okundu bildirimi gönder
    await this.messaging.markConversationRead(conversationId);
    await this.renderConversationList(); // unread sayısını güncelle

    // Sunucudan geçmiş yükle (arka planda)
    this.messaging.loadHistory(conversationId).then(() => {
      this.renderMessageList(conversationId);
    }).catch(console.error);
  }

  async renderMessageList(conversationId) {
    const listEl = document.getElementById('message-list');
    if (!listEl) return;

    const user = this.auth.getCurrentUser();
    const messages = await this.db.getMessages(conversationId, {
      limit: VOYN_CONFIG.MESSAGES_PER_PAGE,
    });

    if (messages.length === 0) {
      listEl.innerHTML = `<div class="empty-messages"><p>Henüz mesaj yok. İlk mesajı sen at! 👋</p></div>`;
      return;
    }

    listEl.innerHTML = messages.map((msg) => this._messageHTML(msg, user.id)).join('');

    // Sona kaydır
    requestAnimationFrame(() => {
      listEl.scrollTop = listEl.scrollHeight;
    });
  }

  _messageHTML(msg, myUserId) {
    const isMine = msg.fromUserId === myUserId;
    const statusIcon = isMine ? this._statusIcon(msg.status) : '';
    const time = this._formatTime(msg.createdAt);

    let contentHTML = '';
    switch (msg.type) {
      case 'text':
        contentHTML = `<p class="msg-text">${this._escapeHtml(msg.content || '')}</p>`;
        break;
      case 'image':
        contentHTML = msg.url
          ? `<img class="msg-image" src="${this._escapeHtml(msg.url)}" alt="Fotoğraf" loading="lazy" />`
          : `<p class="msg-text msg-loading">📷 Fotoğraf yükleniyor…</p>`;
        break;
      case 'video':
        contentHTML = msg.url
          ? `<video class="msg-video" src="${this._escapeHtml(msg.url)}" controls preload="metadata"></video>`
          : `<p class="msg-text msg-loading">🎬 Video yükleniyor…</p>`;
        break;
      case 'voice':
        contentHTML = msg.url
          ? `<div class="msg-voice">
               <button class="play-voice-btn" data-src="${this._escapeHtml(msg.url)}">▶</button>
               <div class="voice-waveform"></div>
             </div>`
          : `<p class="msg-text msg-loading">🎤 Sesli mesaj yükleniyor…</p>`;
        break;
      case 'file':
        contentHTML = msg.url
          ? `<a class="msg-file" href="${this._escapeHtml(msg.url)}" target="_blank" rel="noopener noreferrer" download="${this._escapeHtml(msg.fileName || 'dosya')}">
               📎 ${this._escapeHtml(msg.fileName || 'Dosya')}
               <span class="file-size">${this._formatBytes(msg.fileSize)}</span>
             </a>`
          : `<p class="msg-text msg-loading">📎 Dosya yükleniyor…</p>`;
        break;
      default:
        contentHTML = `<p class="msg-text msg-system">${this._escapeHtml(msg.content || '')}</p>`;
    }

    return `
      <div class="message ${isMine ? 'mine' : 'theirs'}" data-message-id="${msg.id}" data-type="${msg.type}">
        <div class="msg-bubble">
          ${contentHTML}
          <div class="msg-meta">
            <span class="msg-time">${time}</span>
            ${statusIcon}
          </div>
        </div>
      </div>`;
  }

  _statusIcon(status) {
    switch (status) {
      case 'sending':  return '<span class="msg-status sending" title="Gönderiliyor">⏳</span>';
      case 'queued':   return '<span class="msg-status queued" title="Beklemede">🕐</span>';
      case 'sent':     return '<span class="msg-status sent" title="Gönderildi">✓</span>';
      case 'delivered':return '<span class="msg-status delivered" title="Teslim edildi">✓✓</span>';
      case 'read':     return '<span class="msg-status read" title="Okundu">✓✓</span>';
      case 'failed':   return '<span class="msg-status failed" title="Gönderilemedi">✗</span>';
      default:         return '';
    }
  }

  _updateMessageStatusUI(messageId, status) {
    const el = document.querySelector(`[data-message-id="${messageId}"] .msg-status`);
    if (!el) return;
    el.outerHTML = this._statusIcon(status);
  }

  // ─── Profile Screen ───────────────────────────────────────────────────────

  renderProfileScreen() {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    const usernameEl = document.getElementById('profile-username');
    const avatarEl = document.getElementById('profile-avatar');
    const bioEl = document.getElementById('profile-bio');

    if (usernameEl) usernameEl.textContent = user.username || '';
    if (bioEl) bioEl.textContent = user.bio || '';
    if (avatarEl) {
      avatarEl.innerHTML = user.avatar_url
        ? `<img src="${this._escapeHtml(user.avatar_url)}" alt="${this._escapeHtml(user.username)}" />`
        : `<span class="avatar-letter avatar-large">${(user.username || '?')[0].toUpperCase()}</span>`;
    }

    // Tema butonu
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.checked = this._theme === 'light';
    }
  }

  // ─── Event Listeners ──────────────────────────────────────────────────────

  _bindEvents() {
    // Alt navigasyon
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        const screen = item.dataset.screen;
        if (screen) this.showScreen(screen);
      });
    });

    // Auth form gönder
    const authForm = document.getElementById('auth-form');
    if (authForm) {
      authForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this._handleAuthSubmit();
      });
    }

    // Kullanıcı adı giriş — gerçek zamanlı doğrulama
    const usernameInput = document.getElementById('username-input');
    if (usernameInput) {
      let debounceTimer;
      usernameInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this._validateUsernameInput(usernameInput.value), 400);
      });
    }

    // Mesaj gönderme formu
    const msgForm = document.getElementById('message-form');
    if (msgForm) {
      msgForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this._handleSendMessage();
      });
    }

    // Enter ile mesaj gönder (Shift+Enter = yeni satır)
    const msgInput = document.getElementById('message-input');
    if (msgInput) {
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._handleSendMessage();
        }
      });
    }

    // Dosya ekleme
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('file-input');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => this._handleFileAttach(e));
    }

    // Sesli mesaj
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) {
      voiceBtn.addEventListener('mousedown', () => this._startVoice());
      voiceBtn.addEventListener('mouseup', () => this._stopVoice());
      voiceBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this._startVoice(); });
      voiceBtn.addEventListener('touchend', (e) => { e.preventDefault(); this._stopVoice(); });
    }

    // Sesli mesaj oynatma (delegated)
    const msgList = document.getElementById('message-list');
    if (msgList) {
      msgList.addEventListener('click', (e) => {
        const btn = e.target.closest('.play-voice-btn');
        if (btn) this._playVoice(btn.dataset.src, btn);
      });
    }

    // Profil avatar yükleme
    const avatarUpload = document.getElementById('avatar-upload');
    if (avatarUpload) {
      avatarUpload.addEventListener('change', (e) => this._handleAvatarUpload(e));
    }

    // Profil formu
    const profileForm = document.getElementById('profile-form');
    if (profileForm) {
      profileForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this._handleProfileSave();
      });
    }

    // Tema değiştirici
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('change', () => {
        this.toggleTheme();
      });
    }

    // Çıkış yap
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => this._handleLogout());
    }

    // Sohbet ekranı geri butonu
    const backBtn = document.getElementById('chat-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => this.showScreen('home'));
    }

    // Arkadaş arama modalı
    const searchBtn = document.getElementById('search-user-btn');
    const searchInput = document.getElementById('search-user-input');
    if (searchInput) {
      let searchTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => this._handleUserSearch(searchInput.value), 400);
      });
    }

    // Arama ekranı (WebRTC)
    const callAcceptBtn = document.getElementById('call-accept-btn');
    const callRejectBtn = document.getElementById('call-reject-btn');
    if (callAcceptBtn) callAcceptBtn.addEventListener('click', () => this.webrtc?.acceptCall());
    if (callRejectBtn) callRejectBtn.addEventListener('click', () => this.webrtc?.rejectCall());

    // Scroll — eski mesaj yükleme
    const chatMessages = document.getElementById('message-list');
    if (chatMessages) {
      chatMessages.addEventListener('scroll', () => {
        if (chatMessages.scrollTop === 0 && this._activeConversationId) {
          this._loadMoreMessages();
        }
      });
    }
  }

  // ─── Auth Handlers ────────────────────────────────────────────────────────

  async _handleAuthSubmit() {
    const input = document.getElementById('username-input');
    if (!input) return;

    const username = input.value.trim();
    const btn = document.getElementById('auth-submit-btn');

    this._setLoading(btn, true);
    try {
      const user = await this.auth.createAccount(username);
      await this._onLoggedIn(user);
    } catch (err) {
      this._showError(err.message || 'Hesap oluşturulamadı');
    } finally {
      this._setLoading(btn, false);
    }
  }

  async _validateUsernameInput(value) {
    const hint = document.getElementById('username-hint');
    if (!hint) return;

    value = value.trim().toLowerCase();
    if (value.length < VOYN_CONFIG.USERNAME_MIN_LENGTH) {
      hint.textContent = `En az ${VOYN_CONFIG.USERNAME_MIN_LENGTH} karakter gerekli`;
      hint.className = 'input-hint error';
      return;
    }
    if (!VOYN_CONFIG.USERNAME_REGEX.test(value)) {
      hint.textContent = 'Yalnızca harf, rakam ve _ kullanılabilir';
      hint.className = 'input-hint error';
      return;
    }

    hint.textContent = 'Kontrol ediliyor…';
    hint.className = 'input-hint';

    try {
      const available = await this.auth.checkUsernameAvailable(value);
      hint.textContent = available ? '✓ Kullanılabilir' : '✗ Bu kullanıcı adı alınmış';
      hint.className = `input-hint ${available ? 'success' : 'error'}`;
    } catch {
      hint.textContent = '';
    }
  }

  // ─── Messaging Handlers ───────────────────────────────────────────────────

  async _handleSendMessage() {
    const input = document.getElementById('message-input');
    if (!input || !this._activeContactId) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.style.height = 'auto';

    try {
      await this.messaging.sendMessage(this._activeContactId, text, 'text');
      await this.renderMessageList(this._activeConversationId);
    } catch (err) {
      this._showError('Mesaj gönderilemedi: ' + err.message);
    }
  }

  async _handleFileAttach(event) {
    const file = event.target.files[0];
    if (!file || !this._activeContactId) return;

    event.target.value = '';

    if (file.size > VOYN_CONFIG.MAX_FILE_SIZE) {
      this._showError('Dosya boyutu 50 MB\'ı aşamaz');
      return;
    }

    const type = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
      ? 'video'
      : 'file';

    try {
      this._showToast('Dosya gönderiliyor…', 'info');
      await this.messaging.sendMessage(this._activeContactId, file, type);
      await this.renderMessageList(this._activeConversationId);
    } catch (err) {
      this._showError('Dosya gönderilemedi: ' + err.message);
    }
  }

  async _startVoice() {
    const btn = document.getElementById('voice-btn');
    if (btn) btn.classList.add('recording');
    try {
      await this.messaging.startVoiceRecording();
    } catch (err) {
      this._showError('Mikrofona erişilemiyor: ' + err.message);
    }
  }

  async _stopVoice() {
    const btn = document.getElementById('voice-btn');
    if (btn) btn.classList.remove('recording');

    if (!this._activeContactId) return;

    try {
      const blob = await this.messaging.stopVoiceRecording();
      await this.messaging.sendVoiceMessage(this._activeContactId, blob);
      await this.renderMessageList(this._activeConversationId);
    } catch (err) {
      console.warn('[VoynApp] Voice message error:', err);
    }
  }

  _playVoice(src, btn) {
    if (!src) return;

    // Önceki oynatmayı durdur
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio = null;
      document.querySelectorAll('.play-voice-btn').forEach((b) => (b.textContent = '▶'));
    }

    const audio = new Audio(src);
    this._currentAudio = audio;
    btn.textContent = '⏸';

    audio.play().catch(() => {
      btn.textContent = '▶';
    });

    audio.onended = () => {
      btn.textContent = '▶';
      this._currentAudio = null;
    };

    audio.onerror = () => {
      btn.textContent = '▶';
      this._showError('Ses dosyası oynatılamadı');
    };
  }

  async _loadMoreMessages() {
    if (!this._activeConversationId || this._loadingOlderMessages) return;
    this._loadingOlderMessages = true;

    const listEl = document.getElementById('message-list');
    const firstMsg = listEl?.querySelector('.message');
    const before = firstMsg?.dataset?.createdAt || null;

    try {
      const older = await this.messaging.loadHistory(this._activeConversationId, before);
      if (older.length > 0) {
        await this.renderMessageList(this._activeConversationId);
      }
    } catch (err) {
      console.warn('[VoynApp] Load more messages error:', err);
    } finally {
      this._loadingOlderMessages = false;
    }
  }

  // ─── Incoming message handler ─────────────────────────────────────────────

  async _handleIncomingMessage(message) {
    // Aktif konuşmadaysak direkt ekle
    if (message.conversationId === this._activeConversationId) {
      await this.renderMessageList(this._activeConversationId);
      await this.messaging.markConversationRead(this._activeConversationId);
    } else {
      // Farklı konuşmadaysak in-app toast göster
      const sender = await this.db.getUser(message.fromUserId);
      const name = sender?.username || 'Yeni mesaj';
      const preview = message.type === 'text'
        ? (message.content || '').slice(0, 60)
        : message.type === 'image' ? '📷 Fotoğraf'
        : message.type === 'voice' ? '🎤 Sesli mesaj'
        : '📎 Dosya';

      this._showToast(`${name}: ${preview}`, 'message', () => {
        this._openConversation(message.conversationId, message.fromUserId);
      });
    }

    // Konuşma listesini güncelle
    await this.renderConversationList();
  }

  // ─── Friend Request UI ────────────────────────────────────────────────────

  async _handleFriendRequest(request) {
    const { data: fromUser } = await this.supabase
      .from('users')
      .select('username, avatar_url')
      .eq('id', request.from_user_id)
      .single();

    const name = fromUser?.username || 'Birisi';
    this._showToast(`${name} sana arkadaşlık isteği gönderdi`, 'info', () => {
      this.showScreen('home');
      // Arkadaş istekleri panelini aç
      const panel = document.getElementById('friend-requests-panel');
      if (panel) panel.classList.add('open');
      this.renderFriendRequests();
    });
  }

  async renderFriendRequests() {
    const container = document.getElementById('friend-requests-list');
    if (!container) return;

    const requests = await this.friends.getPendingRequests();

    if (requests.length === 0) {
      container.innerHTML = '<p class="empty-hint">Bekleyen istek yok</p>';
      return;
    }

    container.innerHTML = requests
      .map((req) => {
        const user = req.from_user;
        const avatarLetter = (user?.username || '?')[0].toUpperCase();
        return `
          <div class="friend-request-item" data-request-id="${req.id}">
            <div class="avatar">
              ${user?.avatar_url
                ? `<img src="${this._escapeHtml(user.avatar_url)}" alt="" />`
                : `<span class="avatar-letter">${avatarLetter}</span>`}
            </div>
            <span class="req-username">${this._escapeHtml(user?.username || 'Bilinmeyen')}</span>
            <div class="req-actions">
              <button class="btn-accept" data-request-id="${req.id}">Kabul et</button>
              <button class="btn-reject" data-request-id="${req.id}">Reddet</button>
            </div>
          </div>`;
      })
      .join('');

    container.querySelectorAll('.btn-accept').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await this.friends.acceptRequest(btn.dataset.requestId);
          this._showToast('Arkadaşlık isteği kabul edildi', 'success');
          this.renderFriendRequests();
          this.renderConversationList();
        } catch (err) {
          this._showError(err.message);
        }
      });
    });

    container.querySelectorAll('.btn-reject').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await this.friends.rejectRequest(btn.dataset.requestId);
          this.renderFriendRequests();
        } catch (err) {
          this._showError(err.message);
        }
      });
    });
  }

  // ─── User Search ──────────────────────────────────────────────────────────

  async _handleUserSearch(query) {
    const resultsEl = document.getElementById('search-results');
    if (!resultsEl) return;

    query = query.trim();
    if (query.length < 2) {
      resultsEl.innerHTML = '';
      return;
    }

    try {
      const users = await this.friends.searchUser(query);
      if (users.length === 0) {
        resultsEl.innerHTML = '<p class="empty-hint">Kullanıcı bulunamadı</p>';
        return;
      }

      resultsEl.innerHTML = users
        .map((u) => {
          const letter = (u.username || '?')[0].toUpperCase();
          const actionLabel =
            u.friendshipStatus === 'friends'
              ? 'Mesaj at'
              : u.friendshipStatus === 'request_sent'
              ? 'İstek gönderildi'
              : u.friendshipStatus === 'request_received'
              ? 'Kabul et'
              : 'İstek gönder';

          return `
            <div class="search-result-item" data-user-id="${u.id}" data-status="${u.friendshipStatus}">
              <div class="avatar">
                ${u.avatar_url
                  ? `<img src="${this._escapeHtml(u.avatar_url)}" alt="" />`
                  : `<span class="avatar-letter">${letter}</span>`}
              </div>
              <span class="result-username">${this._escapeHtml(u.username)}</span>
              <button class="btn-add-friend" data-user-id="${u.id}" data-status="${u.friendshipStatus}">
                ${actionLabel}
              </button>
            </div>`;
        })
        .join('');

      resultsEl.querySelectorAll('.btn-add-friend').forEach((btn) => {
        btn.addEventListener('click', () =>
          this._handleSearchAction(btn.dataset.userId, btn.dataset.status)
        );
      });
    } catch (err) {
      resultsEl.innerHTML = `<p class="error-hint">${this._escapeHtml(err.message)}</p>`;
    }
  }

  async _handleSearchAction(userId, status) {
    try {
      if (status === 'friends') {
        // Konuşmaya git
        const convId = this.messaging._getConversationId(this.auth.getCurrentUser().id, userId);
        await this._openConversation(convId, userId);
        document.getElementById('search-modal')?.classList.remove('open');
      } else if (status === 'request_received') {
        const requests = await this.friends.getPendingRequests();
        const req = requests.find((r) => r.from_user.id === userId);
        if (req) {
          await this.friends.acceptRequest(req.id);
          this._showToast('Arkadaşlık isteği kabul edildi', 'success');
        }
      } else if (status === 'none') {
        await this.friends.sendFriendRequest(userId);
        this._showToast('İstek gönderildi', 'success');
      }
    } catch (err) {
      this._showError(err.message);
    }
  }

  // ─── Profile Handlers ─────────────────────────────────────────────────────

  async _handleProfileSave() {
    const usernameEl = document.getElementById('edit-username');
    const bioEl = document.getElementById('edit-bio');
    const btn = document.getElementById('save-profile-btn');

    this._setLoading(btn, true);
    try {
      await this.auth.updateProfile({
        username: usernameEl?.value,
        bio: bioEl?.value,
      });
      this._showToast('Profil güncellendi', 'success');
      this.renderProfileScreen();
    } catch (err) {
      this._showError(err.message);
    } finally {
      this._setLoading(btn, false);
    }
  }

  async _handleAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      this._showToast('Fotoğraf yükleniyor…', 'info');
      await this.auth.uploadAvatar(file);
      this.renderProfileScreen();
      this._showToast('Profil fotoğrafı güncellendi', 'success');
    } catch (err) {
      this._showError(err.message);
    }
  }

  // ─── Logout ───────────────────────────────────────────────────────────────

  async _handleLogout() {
    const confirmed = confirm('Oturumu kapatmak istiyor musun?');
    if (!confirmed) return;

    try {
      this.auth.stopPresenceHeartbeat();
      this.messaging.stopListening();
      this.friends.unsubscribePresence();
      await this.auth.logout();
      this.showScreen('auth');
    } catch (err) {
      console.error('[VoynApp] Logout error:', err);
      this.showScreen('auth');
    }
  }

  // ─── Presence UI ──────────────────────────────────────────────────────────

  _updatePresenceUI(userId, presence) {
    // Konuşma listesindeki nokta
    document.querySelectorAll(`[data-contact-id="${userId}"] .avatar`).forEach((el) => {
      el.classList.toggle('online', presence.isOnline);
    });

    // Açık sohbetin başlığı
    if (this._activeContactId === userId) {
      const statusEl = document.getElementById('chat-header-status');
      if (statusEl) {
        statusEl.textContent = presence.isOnline
          ? 'çevrimiçi'
          : presence.lastSeen
          ? `son görülme: ${this._formatTime(presence.lastSeen)}`
          : '';
      }
    }
  }

  // ─── Theme ────────────────────────────────────────────────────────────────

  toggleTheme() {
    this._theme = this._theme === 'dark' ? 'light' : 'dark';
    this._applyTheme(this._theme);
    localStorage.setItem('voyn_theme', this._theme);
  }

  _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.content = theme === 'dark' ? '#0F0F0F' : '#FFFFFF';
    }
  }

  // ─── Toast Notifications ──────────────────────────────────────────────────

  /**
   * In-app toast bildirimi göster
   * @param {string} text
   * @param {'info'|'success'|'error'|'message'} type
   * @param {Function|null} onClick
   */
  _showToast(text, type = 'info', onClick = null) {
    const existing = document.getElementById('voyn-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'voyn-toast';
    toast.className = `toast toast-${type}`;
    toast.textContent = text;
    toast.setAttribute('role', 'alert');

    if (onClick) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        onClick();
        toast.remove();
      });
    }

    document.body.appendChild(toast);

    // Animasyonla göster
    requestAnimationFrame(() => toast.classList.add('show'));

    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, VOYN_CONFIG.TOAST_DURATION);
  }

  _showError(message) {
    this._showToast(message, 'error');
    console.error('[VoynApp]', message);
  }

  // ─── Service Worker ───────────────────────────────────────────────────────

  async _registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[VoynApp] SW registered:', reg.scope);

      // Push bildirimleri
      if ('Notification' in window && VOYN_CONFIG.VAPID_PUBLIC_KEY !== 'YOUR_VAPID_PUBLIC_KEY') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          await this._subscribePush(reg);
        }
      }
    } catch (err) {
      console.warn('[VoynApp] SW registration failed:', err);
    }
  }

  async _subscribePush(registration) {
    try {
      const existing = await registration.pushManager.getSubscription();
      if (existing) return existing;

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this._urlBase64ToUint8Array(VOYN_CONFIG.VAPID_PUBLIC_KEY),
      });

      // Aboneliği sunucuya kaydet
      await this.supabase.from('push_subscriptions').upsert({
        user_id: this.auth.getCurrentUser().id,
        subscription: JSON.stringify(subscription),
        created_at: new Date().toISOString(),
      });

      return subscription;
    } catch (err) {
      console.warn('[VoynApp] Push subscription failed:', err);
    }
  }

  _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;
    const oneDay = 86400000;

    if (diff < 60000) return 'şimdi';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}dk`;
    if (diff < oneDay) {
      return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }
    if (diff < 7 * oneDay) {
      return date.toLocaleDateString('tr-TR', { weekday: 'short' });
    }
    return date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
  }

  _formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  _setLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.textContent = loading ? 'Lütfen bekleyin…' : btn.dataset.originalText;
  }
}

// ─── Uygulama başlat ──────────────────────────────────────────────────────────

const voynApp = new VoynApp();
document.addEventListener('DOMContentLoaded', () => voynApp.init());
