/**
 * VOYN Auth — Kullanıcı kimlik doğrulama modülü
 * Supabase anonim kullanıcı sistemi + deviceId tabanlı oturum yönetimi
 */

class VoynAuth {
  constructor(supabaseClient, db) {
    this.supabase = supabaseClient;
    this.db = db;
    this.currentUser = null;
    this._listeners = [];
  }

  // ─── Device ID ──────────────────────────────────────────────────────────

  /**
   * Cihaza özgü kalıcı ID üret veya localStorage'dan oku
   * @returns {string} UUID biçiminde cihaz kimliği
   */
  generateDeviceId() {
    const stored = localStorage.getItem('voyn_device_id');
    if (stored) return stored;

    const id = crypto.randomUUID();
    localStorage.setItem('voyn_device_id', id);
    return id;
  }

  getDeviceId() {
    return localStorage.getItem('voyn_device_id') || this.generateDeviceId();
  }

  // ─── Account ─────────────────────────────────────────────────────────────

  /**
   * Yeni hesap oluştur
   * @param {string} username - Benzersiz kullanıcı adı
   * @returns {object} oluşturulan kullanıcı
   */
  async createAccount(username) {
    username = username.trim().toLowerCase();

    // Validasyon
    if (username.length < VOYN_CONFIG.USERNAME_MIN_LENGTH) {
      throw new Error(`Kullanıcı adı en az ${VOYN_CONFIG.USERNAME_MIN_LENGTH} karakter olmalı`);
    }
    if (username.length > VOYN_CONFIG.USERNAME_MAX_LENGTH) {
      throw new Error(`Kullanıcı adı en fazla ${VOYN_CONFIG.USERNAME_MAX_LENGTH} karakter olabilir`);
    }
    if (!VOYN_CONFIG.USERNAME_REGEX.test(username)) {
      throw new Error('Kullanıcı adı yalnızca harf, rakam ve alt çizgi içerebilir');
    }

    // Kullanıcı adı müsait mi?
    const available = await this.checkUsernameAvailable(username);
    if (!available) {
      throw new Error('Bu kullanıcı adı zaten alınmış');
    }

    const deviceId = this.generateDeviceId();

    // Supabase'e kaydet
    const { data, error } = await this.supabase
      .from('users')
      .insert({
        username,
        device_id: deviceId,
        created_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        is_online: true,
      })
      .select()
      .single();

    if (error) throw error;

    // Kullanıcıyı localStorage'a kaydet
    localStorage.setItem('voyn_user_id', data.id);
    localStorage.setItem('voyn_username', data.username);

    // IndexedDB'ye kaydet
    await this.db.saveUser({
      id: data.id,
      username: data.username,
      deviceId: data.device_id,
      avatarUrl: data.avatar_url || null,
      createdAt: data.created_at,
    });

    this.currentUser = data;
    this._notifyListeners('login', data);
    return data;
  }

  /**
   * Kullanıcı adının müsait olup olmadığını kontrol et (Supabase sorgusu)
   * @param {string} username
   * @returns {boolean}
   */
  async checkUsernameAvailable(username) {
    const { data, error } = await this.supabase
      .from('users')
      .select('id')
      .eq('username', username.trim().toLowerCase())
      .maybeSingle();

    if (error) throw error;
    return data === null;
  }

  // ─── Login / Auto-login ───────────────────────────────────────────────────

  /**
   * localStorage'daki deviceId ve userId ile otomatik giriş yap
   * @returns {object|null} giriş yapılan kullanıcı veya null
   */
  async autoLogin() {
    const userId = localStorage.getItem('voyn_user_id');
    const deviceId = localStorage.getItem('voyn_device_id');

    if (!userId || !deviceId) return null;

    const { data, error } = await this.supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (error || !data) {
      // Yerel veri geçersiz, temizle
      this._clearLocalStorage();
      return null;
    }

    // Çevrimiçi durumu güncelle
    await this.supabase
      .from('users')
      .update({ is_online: true, last_seen: new Date().toISOString() })
      .eq('id', userId);

    // IndexedDB'yi güncelle
    await this.db.saveUser({
      id: data.id,
      username: data.username,
      deviceId: data.device_id,
      avatarUrl: data.avatar_url || null,
      bio: data.bio || '',
      createdAt: data.created_at,
    });

    this.currentUser = data;
    this._notifyListeners('login', data);
    return data;
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  /**
   * Profil bilgilerini güncelle
   * @param {object} data - { username?, bio?, avatar_url? }
   */
  async updateProfile(data) {
    if (!this.currentUser) throw new Error('Oturum açılmamış');

    const updates = {};
    if (data.username !== undefined) {
      const username = data.username.trim().toLowerCase();
      if (username !== this.currentUser.username) {
        const available = await this.checkUsernameAvailable(username);
        if (!available) throw new Error('Bu kullanıcı adı zaten alınmış');
        updates.username = username;
      }
    }
    if (data.bio !== undefined) updates.bio = data.bio;
    if (data.avatar_url !== undefined) updates.avatar_url = data.avatar_url;
    updates.updated_at = new Date().toISOString();

    const { data: updated, error } = await this.supabase
      .from('users')
      .update(updates)
      .eq('id', this.currentUser.id)
      .select()
      .single();

    if (error) throw error;

    this.currentUser = updated;
    if (updated.username) localStorage.setItem('voyn_username', updated.username);

    // IndexedDB güncelle
    await this.db.saveUser({
      id: updated.id,
      username: updated.username,
      deviceId: updated.device_id,
      avatarUrl: updated.avatar_url || null,
      bio: updated.bio || '',
    });

    this._notifyListeners('profileUpdate', updated);
    return updated;
  }

  /**
   * Profil fotoğrafı yükle (Supabase Storage)
   * @param {File} file - Fotoğraf dosyası
   * @returns {string} Yüklenen dosyanın public URL'si
   */
  async uploadAvatar(file) {
    if (!this.currentUser) throw new Error('Oturum açılmamış');
    if (file.size > 5 * 1024 * 1024) throw new Error('Profil fotoğrafı en fazla 5 MB olabilir');

    const ext = file.name.split('.').pop();
    const fileName = `${this.currentUser.id}/avatar.${ext}`;

    const { error: uploadError } = await this.supabase.storage
      .from(VOYN_CONFIG.STORAGE_BUCKETS.AVATARS)
      .upload(fileName, file, { upsert: true, contentType: file.type });

    if (uploadError) throw uploadError;

    const { data: urlData } = this.supabase.storage
      .from(VOYN_CONFIG.STORAGE_BUCKETS.AVATARS)
      .getPublicUrl(fileName);

    // Profili URL ile güncelle
    await this.updateProfile({ avatar_url: urlData.publicUrl });
    return urlData.publicUrl;
  }

  // ─── Logout ───────────────────────────────────────────────────────────────

  /**
   * Oturumu kapat, yerel veriyi temizle
   */
  async logout() {
    if (this.currentUser) {
      // Çevrimdışı yap
      await this.supabase
        .from('users')
        .update({ is_online: false, last_seen: new Date().toISOString() })
        .eq('id', this.currentUser.id)
        .catch(() => {});
    }

    this._clearLocalStorage();
    await this.db.clearAll();
    this.currentUser = null;
    this._notifyListeners('logout', null);
  }

  // ─── Presence ─────────────────────────────────────────────────────────────

  /**
   * Çevrimiçi durumunu güncelle (heartbeat)
   */
  async pingPresence() {
    if (!this.currentUser) return;
    await this.supabase
      .from('users')
      .update({ is_online: true, last_seen: new Date().toISOString() })
      .eq('id', this.currentUser.id)
      .catch(() => {});
  }

  /**
   * Periyodik heartbeat başlat
   */
  startPresenceHeartbeat() {
    this._presenceInterval = setInterval(
      () => this.pingPresence(),
      VOYN_CONFIG.PRESENCE_INTERVAL
    );

    // Sekme kapanınca çevrimdışı yap
    window.addEventListener('beforeunload', () => {
      navigator.sendBeacon(
        `${VOYN_CONFIG.SUPABASE_URL}/rest/v1/users?id=eq.${this.currentUser?.id}`,
        JSON.stringify({ is_online: false, last_seen: new Date().toISOString() })
      );
    });
  }

  stopPresenceHeartbeat() {
    if (this._presenceInterval) {
      clearInterval(this._presenceInterval);
      this._presenceInterval = null;
    }
  }

  // ─── Event listeners ─────────────────────────────────────────────────────

  onAuthChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== callback);
    };
  }

  _notifyListeners(event, data) {
    this._listeners.forEach((cb) => cb(event, data));
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _clearLocalStorage() {
    ['voyn_user_id', 'voyn_username', 'voyn_device_id'].forEach((k) =>
      localStorage.removeItem(k)
    );
  }

  isLoggedIn() {
    return this.currentUser !== null;
  }

  getCurrentUser() {
    return this.currentUser;
  }
}
