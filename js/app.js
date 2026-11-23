/**
 * VOYN App — Ana Uygulama Kontrolcüsü
 * Ekranlar, navigasyon, kişi arama, anlık sohbet ve WebRTC entegrasyonu
 */

class VoynApp {
  constructor() {
    this.db = null;
    this.auth = null;
    this.messaging = null;
    this.friends = null;
    this.webrtc = null;
    this.push = null;

    this._activeScreen = null;
    this._activeConversationId = null;
    this._activeContactId = null;
    this._theme = localStorage.getItem('voyn_theme') || 'dark';
    this._toastTimer = null;
    this.supabase = null;
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────

  async init() {
    try {
      // 1. Supabase İstemcisi
      this.supabase = supabase.createClient(
        VOYN_CONFIG.SUPABASE_URL,
        VOYN_CONFIG.SUPABASE_ANON_KEY
      );

      // 2. IndexedDB
      this.db = new VoynDB();
      await this.db.init();

      // 3. Modüller
      this.auth = new VoynAuth(this.supabase, this.db);
      this.friends = new VoynFriends(this.supabase, this.db, this.auth);
      this.messaging = new VoynMessaging(this.supabase, this.db, this.auth);

      if (typeof VoynWebRTC !== 'undefined') {
        this.webrtc = new VoynWebRTC(this.supabase, this.auth);
      }

      // 4. Tema
      this._applyTheme(this._theme);

      // 5. Olay Dinleyicileri
      this._bindEvents();

      // 6. Giriş Kontrolü
      const user = await this.auth.autoLogin();
      if (user) {
        await this._onLoggedIn(user);
      } else {
        this.showScreen('auth');
      }

      // 7. Service Worker
      this._registerServiceWorker();
    } catch (err) {
      console.error('[VoynApp] Başlatma hatası:', err);
      this.showScreen('auth');
    }
  }

  async _onLoggedIn(user) {
    console.log('[VoynApp] Giriş yapıldı:', user.username);
    this.auth.startPresenceHeartbeat();
    await this.messaging.startListening();
    this.messaging.onMessage((msg) => {
      if (this._activeScreen === 'chat' && this._activeConversationId === msg.conversationId) {
        this.renderMessageList(msg.conversationId);
      } else {
        this.renderConversationList();
        this._showToast(`Yeni mesaj: ${msg.content || 'Dosya'}`, 'info');
      }
    });

    this.showScreen('home');
    await this.renderConversationList();
  }

  // ─── Ekran Navigasyonu ───────────────────────────────────────────────────

  showScreen(name, params = {}) {
    const screens = document.querySelectorAll('[id^="screen-"]');
    screens.forEach((s) => {
      s.classList.remove('active');
      s.setAttribute('aria-hidden', 'true');
    });

    const target = document.getElementById(`screen-${name}`);
    if (!target) {
      console.warn('[VoynApp] Ekran bulunamadı:', name);
      return;
    }

    target.classList.add('active');
    target.setAttribute('aria-hidden', 'false');
    this._activeScreen = name;

    // Alt navigasyon aktif durumu
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.screen === name);
    });

    if (name === 'home') {
      this.renderConversationList();
    } else if (name === 'chat' && params.conversationId) {
      this._activeConversationId = params.conversationId;
      this._activeContactId = params.contactId;
      this.renderChatScreen(params.conversationId, params.contact);
    } else if (name === 'profile') {
      this.renderProfileScreen();
    }
  }

  // ─── Konuşma & Sohbet Listesi ────────────────────────────────────────────

  async renderConversationList() {
    const listEl = document.getElementById('chat-list') || document.getElementById('conversation-list');
    if (!listEl) return;

    const conversations = await this.db.getAllConversations();
    if (!conversations || conversations.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state" id="empty-chats">
          <div class="empty-icon">💬</div>
          <p>Henüz sohbet yok.</p>
          <p class="empty-sub">Yeni birini bulup sohbet etmek için yukarıdaki 🔍 butonuna dokunun.</p>
        </div>`;
      return;
    }

    const currentUser = this.auth.getCurrentUser();
    const items = await Promise.all(
      conversations.map(async (conv) => {
        const otherId = (conv.participantIds || []).find((id) => id !== currentUser?.id);
        let contact = (await this.db.getUser(otherId)) || { id: otherId, username: 'Kullanıcı' };
        return { conv, contact };
      })
    );

    listEl.innerHTML = items
      .map(({ conv, contact }) => this._conversationItemHTML(conv, contact))
      .join('');

    listEl.querySelectorAll('.chat-item').forEach((el) => {
      el.addEventListener('click', () => {
        const { conversationId, contactId } = el.dataset;
        this._openConversation(conversationId, contactId);
      });
    });
  }

  _conversationItemHTML(conv, contact) {
    const lastMsg = conv.lastMessage;
    const preview = lastMsg
      ? lastMsg.type === 'text'
        ? this._escapeHtml(lastMsg.content || '')
        : `📎 ${lastMsg.type === 'image' ? 'Fotoğraf' : lastMsg.type === 'voice' ? 'Sesli mesaj' : 'Dosya'}`
      : 'Sohbet başladı';

    const time = lastMsg ? this._formatTime(lastMsg.createdAt) : '';
    const unread = conv.unreadCount > 0 ? `<span class="chat-unread badge">${conv.unreadCount}</span>` : '';
    const avatarLetter = (contact.username || '?')[0].toUpperCase();
    const avatarImg = contact.avatarUrl
      ? `<img src="${this._escapeHtml(contact.avatarUrl)}" alt="" class="avatar-img" />`
      : `<span>${avatarLetter}</span>`;

    return `
      <div class="chat-item" data-conversation-id="${conv.id}" data-contact-id="${contact.id}">
        <div class="avatar ${contact.isOnline ? 'avatar--online' : ''}">
          ${avatarImg}
        </div>
        <div class="chat-info">
          <div class="chat-meta">
            <span class="chat-name">${this._escapeHtml(contact.displayName || contact.username)}</span>
            <span class="chat-time">${time}</span>
          </div>
          <div class="chat-preview">
            <span class="chat-last-msg">${preview}</span>
            ${unread}
          </div>
        </div>
      </div>`;
  }

  async _openConversation(conversationId, contactId, contactObj = null) {
    let contact = contactObj;
    if (!contact) {
      contact = await this.db.getUser(contactId);
    }
    if (!contact) {
      const { data } = await this.supabase
        .from('users')
        .select('id, username, display_name, avatar_url, is_online, last_seen')
        .eq('id', contactId)
        .single();
      if (data) {
        contact = {
          id: data.id,
          username: data.username,
          displayName: data.display_name || data.username,
          avatarUrl: data.avatar_url,
          isOnline: data.is_online,
          lastSeen: data.last_seen,
        };
        await this.db.saveUser(contact);
      }
    }

    this._activeConversationId = conversationId;
    this._activeContactId = contactId;
    this.showScreen('chat', { conversationId, contactId, contact });
  }

  // ─── Sohbet Ekranı ───────────────────────────────────────────────────────

  async renderChatScreen(conversationId, contact) {
    const headerName = document.getElementById('chat-partner-name');
    const avatarLetter = document.getElementById('chat-avatar-letter');
    const headerStatus = document.getElementById('chat-partner-status');

    if (contact) {
      if (headerName) headerName.textContent = contact.displayName || contact.username || 'Kullanıcı';
      if (avatarLetter) avatarLetter.textContent = (contact.username || '?')[0].toUpperCase();
      if (headerStatus) {
        headerStatus.textContent = contact.isOnline ? '🟢 çevrimiçi' : 'çevrimdışı';
      }
    }

    await this.renderMessageList(conversationId);

    // Arka planda sunucudan geçmişi çek
    this.messaging.loadHistory(conversationId).then(() => {
      this.renderMessageList(conversationId);
    }).catch(() => {});
  }

  async renderMessageList(conversationId) {
    const listEl = document.getElementById('messages-container') || document.getElementById('message-list');
    if (!listEl) return;

    const currentUser = this.auth.getCurrentUser();
    const messages = await this.db.getMessages(conversationId, { limit: 100 });

    if (!messages || messages.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state" id="empty-messages" style="margin:auto;">
          <p class="empty-sub">Sohbeti başlatmak için bir mesaj yazın 👋</p>
        </div>`;
      return;
    }

    listEl.innerHTML = messages.map((msg) => this._messageHTML(msg, currentUser ? currentUser.id : '')).join('');

    requestAnimationFrame(() => {
      listEl.scrollTop = listEl.scrollHeight;
    });
  }

  _messageHTML(msg, myUserId) {
    const isMine = msg.fromUserId === myUserId;
    const statusIcon = isMine ? (msg.status === 'read' ? '✓✓' : msg.status === 'delivered' ? '✓✓' : '✓') : '';
    const time = this._formatTime(msg.createdAt);
    const letter = (msg.fromUsername || '?')[0].toUpperCase();

    let contentHTML = '';
    switch (msg.type) {
      case 'text':
        contentHTML = `<div class="msg-bubble">${this._escapeHtml(msg.content || '')}</div>`;
        break;
      case 'image':
        contentHTML = msg.url
          ? `<div class="msg-bubble" style="padding:4px;"><img src="${this._escapeHtml(msg.url)}" alt="Fotoğraf" style="max-width:220px;border-radius:12px;" loading="lazy" /></div>`
          : `<div class="msg-bubble">📷 Fotoğraf yükleniyor…</div>`;
        break;
      case 'file':
        contentHTML = `<div class="msg-bubble"><a href="${this._escapeHtml(msg.url || '#')}" target="_blank" download style="color:inherit;text-decoration:underline;">📎 ${this._escapeHtml(msg.fileName || 'Dosya')}</a></div>`;
        break;
      case 'voice':
        contentHTML = `<div class="msg-bubble"><audio controls src="${this._escapeHtml(msg.url || '')}" style="height:36px;max-width:200px;"></audio></div>`;
        break;
      default:
        contentHTML = `<div class="msg-bubble">${this._escapeHtml(msg.content || '')}</div>`;
    }

    return `
      <div class="message ${isMine ? 'message--out' : 'message--in'}">
        ${!isMine ? `<div class="msg-avatar"><span>${letter}</span></div>` : ''}
        <div class="msg-content">
          ${contentHTML}
          <div class="msg-time ${isMine ? 'msg-time--out' : ''}">${time} ${statusIcon}</div>
        </div>
      </div>`;
  }

  // ─── Mesaj Gönderme ───────────────────────────────────────────────────────

  async _handleSendMessage() {
    const input = document.getElementById('msg-input') || document.getElementById('message-input');
    if (!input || !this._activeContactId) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = '';

    const emptyHint = document.getElementById('empty-messages');
    if (emptyHint) emptyHint.style.display = 'none';

    try {
      await this.messaging.sendMessage(this._activeContactId, text, 'text');
      await this.renderMessageList(this._activeConversationId);
      await this.renderConversationList();
    } catch (err) {
      this._showError('Mesaj gönderilemedi: ' + err.message);
    }
  }

  async _handleFileAttach(event) {
    const file = event.target.files[0];
    if (!file || !this._activeContactId) return;
    event.target.value = '';

    const type = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
      ? 'video'
      : 'file';

    this._showToast('Dosya gönderiliyor…', 'info');

    try {
      await this.messaging.sendMessage(this._activeContactId, file, type, {
        fileName: file.name,
        fileSize: file.size,
      });
      await this.renderMessageList(this._activeConversationId);
      await this.renderConversationList();
    } catch (err) {
      this._showError('Dosya yüklenemedi: ' + err.message);
    }
  }

  // ─── Kişi Arama ve Ekleme ────────────────────────────────────────────────

  async _handleUserSearch(query) {
    const resultsEl = document.getElementById('friend-search-results') || document.getElementById('search-results');
    if (!resultsEl) return;

    query = (query || '').trim();
    if (!query) {
      resultsEl.innerHTML = '<div class="search-hint">Kullanıcı adı girerek arama yapın.</div>';
      return;
    }

    resultsEl.innerHTML = '<div class="search-hint">Aranıyor…</div>';

    try {
      const users = await this.friends.searchUser(query);
      if (!users || users.length === 0) {
        resultsEl.innerHTML = '<div class="search-hint">Kullanıcı bulunamadı.</div>';
        return;
      }

      resultsEl.innerHTML = users
        .map((u) => {
          const letter = (u.username || '?')[0].toUpperCase();
          const avatarHtml = u.avatarUrl
            ? `<img src="${this._escapeHtml(u.avatarUrl)}" alt="" class="avatar-img" />`
            : `<span>${letter}</span>`;

          return `
            <div class="search-user-item" data-user-id="${u.id}">
              <div class="search-user-left">
                <div class="avatar avatar--sm ${u.isOnline ? 'avatar--online' : ''}">
                  ${avatarHtml}
                </div>
                <div>
                  <div class="search-user-name">${this._escapeHtml(u.displayName || u.username)}</div>
                  <div class="search-user-status">${u.isOnline ? '🟢 çevrimiçi' : 'çevrimdışı'}</div>
                </div>
              </div>
              <button class="btn-start-chat" data-user-id="${u.id}">
                Sohbet Et
              </button>
            </div>`;
        })
        .join('');

      resultsEl.querySelectorAll('.btn-start-chat').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const userId = btn.dataset.userId;
          const userObj = users.find((u) => u.id === userId);
          if (userObj) {
            await this.startChatWithUser(userObj);
          }
        });
      });
    } catch (err) {
      resultsEl.innerHTML = `<div class="search-hint" style="color:var(--color-danger)">Hata: ${this._escapeHtml(err.message)}</div>`;
    }
  }

  async startChatWithUser(targetUser) {
    try {
      this._showToast(`${targetUser.username} ile sohbet açılıyor…`, 'info');

      // 1. Arkadaş olarak kaydet
      await this.friends.addFriend(targetUser);

      // 2. Modalı kapat
      const modal = document.getElementById('modal-friend-search') || document.getElementById('search-modal');
      if (modal) modal.classList.remove('open');

      // 3. Konuşmayı aç
      const currentUser = this.auth.getCurrentUser();
      const convId = this.messaging._getConversationId(currentUser.id, targetUser.id);
      await this._openConversation(convId, targetUser.id, targetUser);
      await this.renderConversationList();
    } catch (err) {
      this._showError('Sohbet başlatılamadı: ' + err.message);
    }
  }

  // ─── Profil Ekranı ────────────────────────────────────────────────────────

  renderProfileScreen() {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    const nameEl = document.getElementById('profile-name');
    const userEl = document.getElementById('profile-username');
    const letterEl = document.getElementById('profile-avatar-letter');

    if (nameEl) nameEl.textContent = user.username;
    if (userEl) userEl.textContent = user.username;
    if (letterEl) letterEl.textContent = (user.username || '?')[0].toUpperCase();
  }

  // ─── Olay Dinleyicileri ───────────────────────────────────────────────────

  _bindEvents() {
    // Kişi Arama Modalı Açma / Kapama fonksiyonları
    const openSearchModal = () => {
      const modal = document.getElementById('modal-friend-search');
      if (modal) {
        modal.classList.add('open');
        const input = document.getElementById('friend-search-input');
        if (input) {
          input.value = '';
          input.focus();
          this._handleUserSearch('');
        }
      }
    };

    const closeSearchModal = () => {
      const modal = document.getElementById('modal-friend-search');
      if (modal) modal.classList.remove('open');
    };

    // 1. Alt Navigasyon
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        const screen = item.dataset.screen;

        if (action === 'search') {
          openSearchModal();
          return;
        }

        if (screen) this.showScreen(screen);
      });
    });

    // 2. Auth Form
    const authForm = document.getElementById('auth-form');
    if (authForm) {
      authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('username-input');
        if (!input) return;
        const username = input.value.trim();
        if (!username) return;

        try {
          const user = await this.auth.createAccount(username);
          await this._onLoggedIn(user);
        } catch (err) {
          this._showError(err.message || 'Giriş yapılamadı');
        }
      });
    }

    // 3. Kişi Arama Butonları
    const btnSearchFriend = document.getElementById('btn-search-friend');
    const btnNewChat = document.getElementById('btn-new-chat');
    const navBtnSearch = document.getElementById('nav-btn-search');
    if (btnSearchFriend) btnSearchFriend.addEventListener('click', openSearchModal);
    if (btnNewChat) btnNewChat.addEventListener('click', openSearchModal);
    if (navBtnSearch) navBtnSearch.addEventListener('click', openSearchModal);

    const btnCloseSearch = document.getElementById('btn-close-friend-search');
    if (btnCloseSearch) btnCloseSearch.addEventListener('click', closeSearchModal);

    const modalFriendSearch = document.getElementById('modal-friend-search');
    if (modalFriendSearch) {
      modalFriendSearch.addEventListener('click', (e) => {
        if (e.target === modalFriendSearch) closeSearchModal();
      });
    }

    const searchInput = document.getElementById('friend-search-input') || document.getElementById('search-user-input');
    if (searchInput) {
      let searchTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => this._handleUserSearch(searchInput.value), 300);
      });
    }

    // 4. Sohbet Ekranı Kontrolleri
    const btnChatBack = document.getElementById('btn-chat-back') || document.getElementById('chat-back-btn');
    if (btnChatBack) {
      btnChatBack.addEventListener('click', () => {
        this.showScreen('home');
        this.renderConversationList();
      });
    }

    const btnSend = document.getElementById('btn-send');
    const msgInput = document.getElementById('msg-input') || document.getElementById('message-input');
    if (btnSend) {
      btnSend.addEventListener('click', () => this._handleSendMessage());
    }
    if (msgInput) {
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._handleSendMessage();
        }
      });
    }

    const btnAttach = document.getElementById('btn-attach');
    const fileInput = document.getElementById('file-input');
    if (btnAttach && fileInput) {
      btnAttach.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => this._handleFileAttach(e));
    }

    // 5. Sesli / Görüntülü Arama Butonları
    const btnVoiceCall = document.getElementById('btn-voice-call');
    const btnVideoCall = document.getElementById('btn-video-call');
    if (btnVoiceCall) {
      btnVoiceCall.addEventListener('click', () => {
        if (this.webrtc && this._activeContactId) {
          this.webrtc.startCall(this._activeContactId, 'audio');
        } else {
          this._showToast('Sesli arama başlatılıyor…', 'info');
        }
      });
    }
    if (btnVideoCall) {
      btnVideoCall.addEventListener('click', () => {
        if (this.webrtc && this._activeContactId) {
          this.webrtc.startCall(this._activeContactId, 'video');
        } else {
          this._showToast('Görüntülü arama başlatılıyor…', 'info');
        }
      });
    }

    // 6. Tema Değiştirici
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.checked = this._theme === 'dark';
      themeToggle.addEventListener('change', () => {
        this._theme = themeToggle.checked ? 'dark' : 'light';
        this._applyTheme(this._theme);
      });
    }

    // 7. Çıkış
    const logoutBtn = document.querySelector('.settings-item--danger');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        if (confirm('Oturumu kapatmak istediğinize emin misiniz?')) {
          await this.auth.logout();
          this.showScreen('auth');
        }
      });
    }
  }

  // ─── Tema & Bildirim Yardımcıları ─────────────────────────────────────────

  _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('voyn_theme', theme);
  }

  _showToast(msg, type = 'info') {
    let toast = document.getElementById('voyn-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'voyn-toast';
      toast.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(20, 20, 25, 0.9);
        color: #fff;
        padding: 10px 20px;
        border-radius: 9999px;
        border: 1px solid rgba(124, 58, 237, 0.4);
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        font-size: 13px;
        font-weight: 500;
        z-index: 9999;
        transition: all 0.25s ease;
        backdrop-filter: blur(10px);
      `;
      document.body.appendChild(toast);
    }

    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-10px)';
    }, 2800);
  }

  _showError(msg) {
    this._showToast(msg, 'error');
  }

  _formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async _registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('sw.js');
      } catch (err) {
        console.warn('SW kaydı:', err);
      }
    }
  }
}

// ─── Başlat ────────────────────────────────────────────────────────────────

const voynApp = new VoynApp();
document.addEventListener('DOMContentLoaded', () => voynApp.init());
