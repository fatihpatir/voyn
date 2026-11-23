/**
 * VOYN Service Worker
 * Cache stratejisi, Push bildirimleri, Offline fallback, Background sync
 */

const SW_VERSION = 'v1.0.2';
const CACHE_NAME = `voyn-cache-${SW_VERSION}`;
const OFFLINE_URL = './offline.html';

// Uygulama kabuğu — cache-first ile saklanacak statik dosyalar
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/config.js',
  './js/db.js',
  './js/auth.js',
  './js/messaging.js',
  './js/friends.js',
  './js/webrtc.js',
  './js/push.js',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './offline.html',
];

// Network-first ile çekilecek URL kalıpları
const NETWORK_FIRST_PATTERNS = [
  /\/api\//,
  /supabase\.co/,
  /realtime/,
];

/* ═══════════════════════════ INSTALL ══════════════════════════════════ */

self.addEventListener('install', (event) => {
  console.log('[SW] Install:', SW_VERSION);

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Kritik olmayan hatalar için tek tek ekle
      return Promise.allSettled(
        APP_SHELL.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Cache eklenemedi:', url, err))
        )
      );
    }).then(() => {
      // Hemen aktif et (skipWaiting)
      return self.skipWaiting();
    })
  );
});

/* ═══════════════════════════ ACTIVATE ═════════════════════════════════ */

self.addEventListener('activate', (event) => {
  console.log('[SW] Activate:', SW_VERSION);

  event.waitUntil(
    Promise.all([
      // Eski cache'leri temizle
      caches.keys().then(cacheNames =>
        Promise.all(
          cacheNames
            .filter(name => name !== CACHE_NAME)
            .map(name => {
              console.log('[SW] Eski cache siliniyor:', name);
              return caches.delete(name);
            })
        )
      ),
      // Tüm client'ları hemen ele geç
      self.clients.claim(),
    ])
  );

  // Client'lara güncelleme bildir
  self.clients.matchAll({ type: 'window' }).then(clients => {
    clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }));
  });
});

/* ═══════════════════════════ FETCH ════════════════════════════════════ */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Yalnızca GET isteklerini cache'le
  if (request.method !== 'GET') return;

  // Chrome extension vb. atla
  if (!url.protocol.startsWith('http')) return;

  // Network-first kalıpları
  if (NETWORK_FIRST_PATTERNS.some(p => p.test(request.url))) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Navigasyon istekleri (HTML) → Network first, offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Statik varlıklar → Cache first
  event.respondWith(cacheFirst(request));
});

/** Cache first stratejisi */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Çevrimdışı', { status: 503, statusText: 'Offline' });
  }
}

/** Network first stratejisi */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('{}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** Navigasyon isteği — offline.html fallback */
async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
      return response;
    }
  } catch {
    // Çevrimdışı
  }

  // Cache'den index.html dene
  const cached = await caches.match('/index.html');
  if (cached) return cached;

  // Offline fallback
  return caches.match(OFFLINE_URL) || new Response(
    '<html><body><h1>Çevrimdışısınız</h1></body></html>',
    { headers: { 'Content-Type': 'text/html' } }
  );
}

/* ═══════════════════════════ PUSH ═════════════════════════════════════ */

self.addEventListener('push', (event) => {
  console.log('[SW] Push alındı');

  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'VOYN', body: event.data ? event.data.text() : 'Yeni bildirim' };
  }

  const {
    title = 'VOYN',
    body = 'Yeni mesaj',
    icon = 'icons/icon-192.png',
    badge = 'icons/icon-192.png',
    image,
    tag,
    conversationId,
    senderId,
    senderName,
    messageType = 'message',
    url = './',
    silent = false,
  } = data;

  const notificationOptions = {
    body,
    icon,
    badge,
    tag: tag || `voyn-${conversationId || Date.now()}`,
    data: {
      url,
      conversationId,
      senderId,
      senderName,
      type: messageType,
    },
    actions: [
      { action: 'open', title: 'Aç' },
      { action: 'close', title: 'Kapat' },
    ],
    vibrate: [200, 100, 200],
    renotify: true,
    silent,
    timestamp: Date.now(),
  };

  if (image) notificationOptions.image = image;

  // Client'lara bildir (uygulama açıksa)
  const pushPromise = self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'PUSH_RECEIVED', data });
      });

      // Uygulama görünür pencerede açıksa bildirim gösterme
      const hasVisible = clients.some(c => c.visibilityState === 'visible');
      if (!hasVisible) {
        return self.registration.showNotification(title, notificationOptions);
      }
    });

  event.waitUntil(pushPromise);
});

/* ═══════════════════════════ NOTIFICATION CLICK ═══════════════════════ */

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Bildirime tıklandı:', event.action, event.notification.data);

  event.notification.close();

  if (event.action === 'close') return;

  const data = event.notification.data || {};
  const targetUrl = data.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Açık pencere var mı?
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          // Mevcut pencereyi odakla ve mesaj gönder
          client.focus();
          client.postMessage({
            type: 'NOTIFICATION_CLICK',
            data: {
              conversationId: data.conversationId,
              userId: data.senderId,
              type: data.type,
              url: targetUrl,
            },
          });
          return;
        }
      }

      // Pencere yoksa yeni aç
      return self.clients.openWindow(targetUrl);
    })
  );
});

/* ═══════════════════════════ NOTIFICATION CLOSE ═══════════════════════ */

self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Bildirim kapatıldı:', event.notification.tag);
  // İstatistik amaçlı loglanabilir
});

/* ═══════════════════════════ BACKGROUND SYNC ══════════════════════════ */

self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'voyn-send-messages') {
    event.waitUntil(syncPendingMessages());
  }

  if (event.tag === 'voyn-update-status') {
    event.waitUntil(syncReadStatus());
  }
});

async function syncPendingMessages() {
  try {
    // Client'a mesaj gönder, IndexedDB'deki kuyruğu işlesin
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_PENDING_MESSAGES' });
    });
  } catch (err) {
    console.error('[SW] Mesaj sync hatası:', err);
  }
}

async function syncReadStatus() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_READ_STATUS' });
    });
  } catch (err) {
    console.error('[SW] Okundu sync hatası:', err);
  }
}

/* ═══════════════════════════ PERIODIC SYNC ════════════════════════════ */

self.addEventListener('periodicsync', (event) => {
  console.log('[SW] Periodic sync:', event.tag);

  if (event.tag === 'voyn-refresh') {
    event.waitUntil(periodicRefresh());
  }
});

async function periodicRefresh() {
  // Arka planda önbelleği taze tut
  try {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(
      APP_SHELL.slice(0, 3).map(url => // Sadece kritik dosyaları yenile
        fetch(url).then(res => {
          if (res.ok) cache.put(url, res);
        }).catch(() => {})
      )
    );
  } catch (err) {
    console.warn('[SW] Periodic refresh hatası:', err);
  }
}

/* ═══════════════════════════ MESSAGE ══════════════════════════════════ */

self.addEventListener('message', (event) => {
  const { type, data } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'CACHE_URLS':
      if (Array.isArray(data)) {
        caches.open(CACHE_NAME).then(cache => cache.addAll(data));
      }
      break;

    case 'CLEAR_CACHE':
      caches.delete(CACHE_NAME).then(() => {
        event.source?.postMessage({ type: 'CACHE_CLEARED' });
      });
      break;

    default:
      break;
  }
});

console.log('[SW] VOYN Service Worker yüklendi:', SW_VERSION);
