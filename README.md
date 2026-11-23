# VOYN

```
 ██╗   ██╗ ██████╗ ██╗   ██╗███╗   ██╗
 ██║   ██║██╔═══██╗╚██╗ ██╔╝████╗  ██║
 ██║   ██║██║   ██║ ╚████╔╝ ██╔██╗ ██║
 ╚██╗ ██╔╝██║   ██║  ╚██╔╝  ██║╚██╗██║
  ╚████╔╝ ╚██████╔╝   ██║   ██║ ╚████║
   ╚═══╝   ╚═════╝    ╚═╝   ╚═╝  ╚═══╝
     Bağlan. Konuş. Paylaş.
```

**VOYN**, cihaz kimliği tabanlı, hesap gerektirmeyen, uçtan uca güvenli bir anlık mesajlaşma PWA uygulamasıdır. Supabase altyapısı ve WebRTC üzerine inşa edilmiştir; kurulum gerektirmeden tarayıcıdan çalışır, Ana Ekrana eklenebilir.

---

## ✨ Özellikler

| Özellik | Açıklama |
|---------|----------|
| 🔑 **Hesapsız giriş** | Kullanıcı adı seç, direkt başla — e-posta veya şifre yok |
| 💬 **Anlık mesajlaşma** | Supabase Realtime ile WebSocket tabanlı anlık iletişim |
| 📎 **Medya paylaşımı** | Görüntü, video, ses ve dosya gönderme (maks. 50 MB) |
| 📞 **Sesli & görüntülü arama** | WebRTC P2P, STUN/TURN desteği |
| 🔔 **Push bildirimleri** | Web Push API (Android Chrome'da arka planda çalışır) |
| 📱 **PWA** | iOS ve Android'e Ana Ekran'a eklenebilir, offline çalışır |
| 🌙 **Koyu / açık tema** | Sistem tercihine göre otomatik veya manuel değiştirme |
| 🗑️ **Geçici mesajlar** | Mesajlar 7 gün sonra otomatik silinir |
| 🔒 **RLS güvenliği** | Supabase Row Level Security ile satır düzeyinde veri izolasyonu |

---

## 🛠️ Teknoloji Stack'i

### Frontend
- **Vanilla JS (ES2022+)** — framework bağımlılığı yok
- **CSS Custom Properties** — koyu/açık tema, glassmorphism
- **Service Worker** — offline cache, push bildirimleri
- **IndexedDB** — yerel mesaj ve medya cache'i
- **WebRTC** — P2P sesli/görüntülü arama

### Backend (Supabase)
- **PostgreSQL** — ana veritabanı
- **Supabase Realtime** — WebSocket mesajlaşma
- **Supabase Storage** — avatarlar ve medya dosyaları
- **Supabase Edge Functions** (Deno) — push gönderimi, VAPID anahtar üretimi
- **Row Level Security (RLS)** — satır düzeyinde erişim kontrolü
- **pg_cron** — otomatik temizlik işleri

### Dağıtım
- **GitHub Pages** — statik PWA barındırma (ücretsiz)

---

## 🚀 Kurulum

### Ön Koşullar
- [Supabase hesabı](https://supabase.com) (ücretsiz plan yeterli)
- [Node.js](https://nodejs.org) ≥ 18 (VAPID anahtar üretimi için)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (Edge Function deploy için)
- GitHub hesabı (GitHub Pages için)

---

### 1. Supabase Projesi Oluştur

1. [supabase.com](https://supabase.com) adresine git ve yeni proje oluştur.
2. **Project Settings → API** bölümünden şunları not al:
   - `Project URL`
   - `anon public` key
   - `service_role` key (gizli tut!)

---

### 2. Veritabanı Şemasını Uygula

Supabase Dashboard → **SQL Editor** bölümünde sırasıyla çalıştır:

```bash
# Sıra önemlidir!
1. supabase/schema.sql        # Tablolar, indexler, triggerlar
2. supabase/rls.sql           # Row Level Security politikaları
3. supabase/storage.sql       # Storage bucket'ları ve politikaları
4. supabase/cleanup-cron.sql  # Otomatik temizlik cron job'ları
```

> **Not:** `cleanup-cron.sql` içindeki pg_cron job'ları Supabase Pro planı gerektirir. Free plan kullanıyorsanız `run_all_cleanups()` fonksiyonunu GitHub Actions ile çağırabilirsiniz.

---

### 3. VAPID Anahtarları Üret

Web Push bildirimleri için VAPID anahtar çifti gereklidir:

```bash
npx web-push generate-vapid-keys
```

Çıktı:
```
Public Key:  Bxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Private Key: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

### 4. Ortam Değişkenlerini Ayarla

```bash
cp .env.example .env.local
```

`.env.local` dosyasını düzenle:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
VAPID_PUBLIC_KEY=your-vapid-public-key
VAPID_PRIVATE_KEY=your-vapid-private-key
VAPID_EMAIL=mailto:admin@voyn.app
```

`js/config.js` dosyasında `SUPABASE_URL`, `SUPABASE_ANON_KEY` ve `VAPID_PUBLIC_KEY` değerlerini güncelle:

```js
const VOYN_CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-key',
  VAPID_PUBLIC_KEY: 'your-vapid-public-key',
  // ...
};
```

---

### 5. Edge Functions'ı Deploy Et

```bash
# Supabase CLI ile giriş yap
supabase login

# Projeye bağlan
supabase link --project-ref your-project-ref

# Edge Function'ları deploy et
supabase functions deploy send-push
supabase functions deploy generate-vapid

# Ortam değişkenlerini Supabase'e aktar
supabase secrets set VAPID_PUBLIC_KEY=your-vapid-public-key
supabase secrets set VAPID_PRIVATE_KEY=your-vapid-private-key
supabase secrets set VAPID_EMAIL=mailto:admin@voyn.app
```

---

### 6. GitHub Pages'e Deploy Et

```bash
# Repoyu fork et veya klonla
git clone https://github.com/yourusername/voyn.git
cd voyn

# GitHub'a push et
git add .
git commit -m "Initial VOYN setup"
git push origin main
```

GitHub repo ayarlarından **Settings → Pages → Branch: main / root** seç.

Birkaç dakika sonra uygulamanın adresi:
```
https://yourusername.github.io/voyn/
```

---

## 🔐 Ortam Değişkenleri Referansı

| Değişken | Açıklama | Nerede kullanılır |
|----------|----------|-------------------|
| `SUPABASE_URL` | Supabase proje URL'si | Frontend (config.js) |
| `SUPABASE_ANON_KEY` | Anonim API anahtarı (public) | Frontend (config.js) |
| `SUPABASE_SERVICE_ROLE_KEY` | Servis rolü anahtarı (gizli!) | Edge Functions only |
| `VAPID_PUBLIC_KEY` | Web Push public key | Frontend (sw.js) |
| `VAPID_PRIVATE_KEY` | Web Push private key (gizli!) | Edge Functions only |
| `VAPID_EMAIL` | Push hizmet iletişim e-postası | Edge Functions only |

> [!CAUTION]
> `SUPABASE_SERVICE_ROLE_KEY` ve `VAPID_PRIVATE_KEY` değerlerini asla istemci tarafı koduna ekleme. Bu anahtarlar yalnızca Supabase Edge Functions'ta kullanılmalıdır.

---

## 📱 PWA Kurulum Rehberi

### Android (Chrome)
1. VOYN'u Chrome'da aç
2. Adres çubuğunun sağındaki **⋮ → Ana ekrana ekle** seçeneğine dokun
3. **Ekle** butonuna bas
4. VOYN artık uygulama gibi başlar!

### iOS (Safari)
1. VOYN'u Safari'de aç
2. Alt çubuktaki **Paylaş** ikonuna dokun (kare + yukarı ok)
3. **Ana Ekrana Ekle** seçeneğine dokun
4. **Ekle** butonuna bas

> [!NOTE]
> iOS'ta push bildirim desteği yalnızca iOS 16.4+ sürümlerinde ve PWA Ana Ekran'dan açıldığında çalışır.

---

## ⚠️ Bilinen Sınırlamalar

### iOS Push Bildirimleri
- **Sorun:** iOS'ta uygulama tamamen kapalıyken (arka planda değil) push bildirimleri çalışmaz.
- **Durum:** iOS 16.4+ sürümünde Web Push PWA desteği eklendi ancak arka plan push güvenilirliği hâlâ sınırlı.
- **Öneri:** iOS kullanıcılarının uygulamayı Ana Ekran'dan açmasını ve bildirim iznini vermesini sağla.

### TURN Sunucusu Ücretsiz Limit
- **Sorun:** `openrelay.metered.ca` ücretsiz TURN sunucusu aylık bant genişliği limitine sahiptir.
- **Öneri:** Üretim ortamı için kendi TURN sunucunu kur ([coturn](https://github.com/coturn/coturn)) veya ücretli Metered.ca planına geç.
- **Etki:** Limit aşıldığında simetrik NAT arkasındaki kullanıcılar arama yapamayabilir.

### Supabase Free Plan Limitleri
- Aktif bağlantı: 200 (eş zamanlı Realtime)
- Veritabanı boyutu: 500 MB
- Depolama: 1 GB
- Edge Function çağrısı: 500.000/ay

### pg_cron (Otomatik Temizlik)
- `pg_cron` yalnızca Supabase Pro planında kullanılabilir.
- Free plan için: `run_all_cleanups()` fonksiyonunu GitHub Actions ile saatlik çalıştır.

```yaml
# .github/workflows/cleanup.yml
name: DB Cleanup
on:
  schedule:
    - cron: '0 * * * *'  # Her saat
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Run cleanup
        run: |
          curl -X POST '${{ secrets.SUPABASE_URL }}/rest/v1/rpc/run_all_cleanups' \
            -H 'apikey: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}' \
            -H 'Authorization: Bearer ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}'
```

---

## 📂 Proje Yapısı

```
voyn/
├── index.html                    # Ana PWA sayfası
├── manifest.json                 # PWA manifest
├── sw.js                         # Service Worker
├── .env.example                  # Ortam değişkeni şablonu
├── README.md                     # Bu dosya
│
├── css/
│   └── app.css                   # Uygulama stilleri
│
├── js/
│   ├── config.js                 # Supabase/WebRTC konfigürasyonu
│   ├── db.js                     # IndexedDB yöneticisi
│   ├── auth.js                   # Kimlik doğrulama
│   ├── messaging.js              # Mesajlaşma sistemi
│   ├── friends.js                # Arkadaş & kişi yönetimi
│   ├── webrtc.js                 # WebRTC arama motoru
│   ├── push.js                   # Push bildirim yöneticisi
│   └── app.js                    # Ana uygulama mantığı
│
├── icons/
│   ├── icon.svg                  # Kaynak SVG ikon
│   └── generate-icons.html       # PNG üretici araç
│
└── supabase/
    ├── schema.sql                # Veritabanı şeması
    ├── rls.sql                   # Güvenlik politikaları
    ├── storage.sql               # Storage bucket kurulumu
    ├── cleanup-cron.sql          # Otomatik temizlik job'ları
    └── functions/
        ├── send-push/
        │   └── index.ts          # Push bildirim Edge Function
        └── generate-vapid/
            └── index.ts          # VAPID anahtar üreticisi
```

---

## 📄 Lisans

MIT License — © 2024 VOYN

Serbestçe kullanabilir, değiştirebilir ve dağıtabilirsiniz.

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://fatihpatir.github.io/web">Fatih PATIR</a></sub>
</div>
