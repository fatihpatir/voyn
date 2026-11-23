/**
 * VOYN Push - Web Push Bildirim Sistemi
 * VAPID tabanlı, iOS uyarısı dahil
 */

class VoynPush {
  constructor(supabaseClient, currentUser) {
    this.supabase = supabaseClient;
    this.currentUser = currentUser;
    this.swRegistration = null;
    this.subscription = null;

    // VAPID public key (config'den veya fallback)
    this.vapidPublicKey =
      (typeof VOYN_CONFIG !== 'undefined' && VOYN_CONFIG.VAPID_PUBLIC_KEY) ||
      'YOUR_VAPID_PUBLIC_KEY_HERE';

    // Callback'ler
    this.onNotificationClick = null; // (data) => void
    this.onSubscriptionChange = null; // (sub) => void
  }

  /* ─────────────────────────── PUBLIC API ──────────────────────────── */

  /**
   * Push sistemini başlat
   * Service Worker'ı kaydet, mevcut subscription'ı yükle
   */
  async init() {
    try {
      // Service Worker desteği var mı?
      if (!('serviceWorker' in navigator)) {
        console.warn('[Push] Service Worker desteklenmiyor');
        return false;
      }

      // iOS Safari kontrolü
      if (this._isIOS()) {
        this._showIOSInstallHint();
        return false;
      }

      // Push desteği var mı?
      if (!('PushManager' in window)) {
        console.warn('[Push] Push bildirimleri desteklenmiyor');
        return false;
      }

      // Service Worker'ı kaydet
      this.swRegistration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      });

      console.log('[Push] Service Worker kayıt başarılı:', this.swRegistration.scope);

      // Mevcut subscription'ı yükle
      this.subscription = await this.swRegistration.pushManager.getSubscription();

      if (this.subscription) {
        // Supabase'deki kayıtla senkronize et
        await this._syncSubscription(this.subscription);
      }

      // Service Worker'dan gelen mesajları dinle
      this._listenToServiceWorker();

      return true;
    } catch (err) {
      console.error('[Push] Init hatası:', err);
      return false;
    }
  }

  /**
   * Bildirim izni iste
   * @returns {'granted'|'denied'|'default'}
   */
  async requestPermission() {
    if (!('Notification' in window)) {
      console.warn('[Push] Notification API desteklenmiyor');
      return 'denied';
    }

    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';

    // İzin iste
    const permission = await Notification.requestPermission();
    console.log('[Push] Bildirim izni:', permission);

    if (permission === 'granted') {
      await this.subscribeToPush();
    }

    return permission;
  }

  /**
   * Push aboneliği oluştur ve Supabase'e kaydet
   */
  async subscribeToPush() {
    try {
      if (!this.swRegistration) {
        throw new Error('Service Worker henüz kayıt olmadı');
      }

      if (Notification.permission !== 'granted') {
        const perm = await this.requestPermission();
        if (perm !== 'granted') return null;
      }

      // Mevcut aboneliği iptal et (yenile)
      const existing = await this.swRegistration.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();

      // Yeni abonelik oluştur
      this.subscription = await this.swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this._urlBase64ToUint8Array(this.vapidPublicKey),
      });

      console.log('[Push] Yeni subscription oluşturuldu');

      // Supabase'e kaydet
      await this._syncSubscription(this.subscription);

      if (typeof this.onSubscriptionChange === 'function') {
        this.onSubscriptionChange(this.subscription);
      }

      return this.subscription;
    } catch (err) {
      console.error('[Push] Subscribe hatası:', err);
      throw err;
    }
  }

  /**
   * Push aboneliğini iptal et
   */
  async unsubscribe() {
    try {
      if (this.subscription) {
        await this.subscription.unsubscribe();
        this.subscription = null;
      }

      // Supabase'den sil
      if (this.currentUser) {
        await this.supabase
          .from('push_subscriptions')
          .delete()
          .eq('user_id', this.currentUser.id)
          .eq('device_id', this._getDeviceId());
      }

      if (typeof this.onSubscriptionChange === 'function') {
        this.onSubscriptionChange(null);
      }

      console.log('[Push] Abonelik iptal edildi');
    } catch (err) {
      console.error('[Push] Unsubscribe hatası:', err);
    }
  }

  /**
   * Service Worker'a mesaj gönder
   * @param {Object} message
   */
  async sendToServiceWorker(message) {
    if (!this.swRegistration || !this.swRegistration.active) {
      console.warn('[Push] Service Worker aktif değil');
      return;
    }
    this.swRegistration.active.postMessage(message);
  }

  /**
   * Bildirime tıklandığında çalışacak işleyici
   * (Service Worker'dan gelen mesaj üzerinden)
   */
  handleNotificationClick(data) {
    if (!data) return;

    const { conversationId, userId, type } = data;

    if (type === 'message' && conversationId) {
      // Konuşmayı aç
      if (window.voynApp && typeof window.voynApp.openConversation === 'function') {
        window.voynApp.openConversation(conversationId);
      } else {
        // Fallback: URL hash ile yönlendir
        window.location.hash = `#chat/${conversationId}`;
      }
    } else if (type === 'call' && userId) {
      // Arama ekranını aç
      if (window.voynApp && typeof window.voynApp.showCallScreen === 'function') {
        window.voynApp.showCallScreen(userId);
      }
    }

    if (typeof this.onNotificationClick === 'function') {
      this.onNotificationClick(data);
    }
  }

  /**
   * Push bildirim durumu
   */
  getStatus() {
    return {
      supported: 'serviceWorker' in navigator && 'PushManager' in window,
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      subscribed: !!this.subscription,
      swRegistered: !!this.swRegistration,
      isIOS: this._isIOS(),
      isStandalone: window.matchMedia('(display-mode: standalone)').matches,
    };
  }

  /* ─────────────────────────── PRIVATE ────────────────────────────── */

  /**
   * Subscription'ı Supabase'e kaydet/güncelle
   */
  async _syncSubscription(subscription) {
    if (!this.currentUser) return;

    const subJSON = subscription.toJSON();

    await this.supabase.from('push_subscriptions').upsert(
      {
        user_id: this.currentUser.id,
        device_id: this._getDeviceId(),
        endpoint: subJSON.endpoint,
        p256dh: subJSON.keys.p256dh,
        auth: subJSON.keys.auth,
        user_agent: navigator.userAgent,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,device_id' }
    );
  }

  /**
   * Service Worker'dan gelen mesajları dinle
   */
  _listenToServiceWorker() {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const { type, data } = event.data || {};

      switch (type) {
        case 'NOTIFICATION_CLICK':
          this.handleNotificationClick(data);
          break;

        case 'PUSH_RECEIVED':
          // Uygulama açıkken bildirim geldiğinde
          if (window.voynApp && typeof window.voynApp.showInAppNotification === 'function') {
            window.voynApp.showInAppNotification(data);
          }
          break;

        case 'SW_UPDATED':
          // Service Worker güncellendi, kullanıcıya bildir
          this._showUpdateNotification();
          break;

        default:
          break;
      }
    });
  }

  /**
   * iOS cihazı mı?
   */
  _isIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  /**
   * iOS "Ana ekrana ekle" talimatı göster
   */
  _showIOSInstallHint() {
    // Zaten standalone modda mı?
    if (window.matchMedia('(display-mode: standalone)').matches) return;

    // localStorage'da gösterilmiş mi?
    if (localStorage.getItem('voyn_ios_hint_shown')) return;

    const isStandalonePWA = window.navigator.standalone;
    if (isStandalonePWA) return;

    // Toast oluştur
    const hint = document.createElement('div');
    hint.id = 'ios-install-hint';
    hint.innerHTML = `
      <div class="ios-hint-content">
        <div class="ios-hint-icon">📱</div>
        <div class="ios-hint-text">
          <strong>Bildirimleri etkinleştir</strong>
          <p>Safari'de paylaş ikonuna <span class="ios-share-icon">⬆️</span> dokun, 
          sonra <strong>"Ana Ekrana Ekle"</strong> seçeneğini seç.</p>
        </div>
        <button class="ios-hint-close" onclick="this.parentElement.parentElement.remove(); localStorage.setItem('voyn_ios_hint_shown', '1')">✕</button>
      </div>
    `;
    hint.style.cssText = `
      position: fixed; bottom: 80px; left: 16px; right: 16px;
      background: rgba(30,30,40,0.97); border: 1px solid rgba(124,58,237,0.4);
      border-radius: 16px; padding: 16px; z-index: 9999;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      animation: slideUp 0.3s ease;
    `;
    document.body.appendChild(hint);

    // 10 saniye sonra otomatik gizle
    setTimeout(() => hint.remove(), 10000);

    localStorage.setItem('voyn_ios_hint_shown', '1');
  }

  /**
   * Service Worker güncelleme bildirimi
   */
  _showUpdateNotification() {
    const banner = document.createElement('div');
    banner.innerHTML = `
      <span>VOYN güncellendi!</span>
      <button onclick="window.location.reload()">Yenile</button>
    `;
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0;
      background: #7C3AED; color: white; padding: 12px 16px;
      display: flex; justify-content: space-between; align-items: center;
      z-index: 10000; font-size: 14px;
    `;
    document.body.prepend(banner);
  }

  /**
   * VAPID public key'i Uint8Array'e çevir
   */
  _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  /**
   * Cihaz ID'sini al (localStorage'dan)
   */
  _getDeviceId() {
    let deviceId = localStorage.getItem('voyn_device_id');
    if (!deviceId) {
      deviceId = crypto.randomUUID ? crypto.randomUUID() : `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('voyn_device_id', deviceId);
    }
    return deviceId;
  }

  /**
   * Kaynakları temizle
   */
  destroy() {
    this.swRegistration = null;
    this.subscription = null;
  }
}

// Global export
if (typeof window !== 'undefined') {
  window.VoynPush = VoynPush;
}
