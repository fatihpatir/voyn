// VOYN Config
// Not: Gerçek değerleri .env.local dosyasına koyun ve bu dosyayı .gitignore'a ekleyin.
// Supabase dashboard'dan alınan değerleri buraya girin.

const VOYN_CONFIG = {
  // Supabase proje URL'si
  SUPABASE_URL: 'https://ywcqadkgyfioxwbfstus.supabase.co',

  // Supabase anonim / publishable API anahtarı
  SUPABASE_ANON_KEY: 'sb_publishable_SYFz_e2VL_0iru-7o3eC5A_K5l5dzts',

  // Web Push bildirimleri için VAPID public key
  // Üretmek için: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: 'YOUR_VAPID_PUBLIC_KEY',

  // WebRTC ICE sunucuları — STUN
  STUN_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
  ],

  // WebRTC ICE sunucuları — TURN (Metered.ca ücretsiz tier)
  TURN_SERVERS: [
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],

  // Maksimum dosya boyutu (50 MB)
  MAX_FILE_SIZE: 50 * 1024 * 1024,

  // Sunucu tarafı mesaj TTL (7 gün, saniye cinsinden)
  MESSAGE_TTL: 7 * 24 * 60 * 60,

  // Uygulama sürümü
  APP_VERSION: '1.0.0',

  // IndexedDB veritabanı adı ve sürümü
  DB_NAME: 'voyn_db',
  DB_VERSION: 1,

  // Supabase Storage bucket adları
  STORAGE_BUCKETS: {
    MEDIA: 'voyn-media',
    AVATARS: 'voyn-avatars',
    VOICE: 'voyn-voice',
  },

  // Desteklenen mesaj tipleri
  MESSAGE_TYPES: {
    TEXT: 'text',
    IMAGE: 'image',
    VIDEO: 'video',
    FILE: 'file',
    VOICE: 'voice',
    SYSTEM: 'system',
  },

  // Çevrimiçi durum güncelleme aralığı (ms)
  PRESENCE_INTERVAL: 30000,

  // Toast bildirim süresi (ms)
  TOAST_DURATION: 3500,

  // Mesaj yükleme sayısı (sayfalama)
  MESSAGES_PER_PAGE: 40,

  // Kullanıcı adı kuralları
  USERNAME_MIN_LENGTH: 3,
  USERNAME_MAX_LENGTH: 20,
  USERNAME_REGEX: /^[a-zA-Z0-9_]+$/,
};

// ICE yapılandırmasını birleştir
VOYN_CONFIG.ICE_SERVERS = [
  ...VOYN_CONFIG.STUN_SERVERS,
  ...VOYN_CONFIG.TURN_SERVERS,
];

// Dondur (yanlışlıkla değiştirilmesin)
Object.freeze(VOYN_CONFIG);
