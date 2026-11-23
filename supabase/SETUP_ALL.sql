-- ============================================================
-- VOYN PWA - TEK SEFERLİK TAM KURULUM (SETUP ALL)
-- ============================================================
-- Bu dosyadaki tüm SQL kodunu Supabase Dashboard > SQL Editor
-- sayfasına yapıştırıp "Run" butonuna basarak tek seferde çalıştırabilirsiniz.
-- ============================================================

-- 1. EKLENTİLER
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 2. TABLOLAR
-- ============================================================

-- users tablosu
CREATE TABLE IF NOT EXISTS public.users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username          TEXT UNIQUE NOT NULL CHECK (length(username) >= 3 AND length(username) <= 30),
  device_id         TEXT UNIQUE NOT NULL,
  display_name      TEXT,
  avatar_url        TEXT,
  bio               TEXT,
  is_online         BOOLEAN DEFAULT false,
  last_seen         TIMESTAMPTZ DEFAULT NOW(),
  push_subscription JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- friendships tablosu
CREATE TABLE IF NOT EXISTS public.friendships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  UUID REFERENCES public.users(id) ON DELETE CASCADE,
  addressee_id  UUID REFERENCES public.users(id) ON DELETE CASCADE,
  status        TEXT CHECK (status IN ('pending', 'accepted', 'blocked')) DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(requester_id, addressee_id)
);

-- messages tablosu (cihazlar arası aktarım için, teslim sonrası silinir)
CREATE TABLE IF NOT EXISTS public.messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  sender_id       UUID REFERENCES public.users(id) ON DELETE CASCADE,
  receiver_id     UUID REFERENCES public.users(id) ON DELETE CASCADE,
  content         TEXT,
  type            TEXT CHECK (type IN ('text', 'image', 'video', 'file', 'audio', 'call')) DEFAULT 'text',
  file_url        TEXT,
  file_name       TEXT,
  file_size       BIGINT,
  status          TEXT CHECK (status IN ('sent', 'delivered', 'read')) DEFAULT 'sent',
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- calls tablosu (WebRTC sinyalleşmesi)
CREATE TABLE IF NOT EXISTS public.calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id       UUID REFERENCES public.users(id) ON DELETE CASCADE,
  callee_id       UUID REFERENCES public.users(id) ON DELETE CASCADE,
  type            TEXT CHECK (type IN ('audio', 'video')) DEFAULT 'audio',
  status          TEXT CHECK (status IN ('ringing', 'answered', 'rejected', 'ended', 'missed')) DEFAULT 'ringing',
  offer           JSONB,
  answer          JSONB,
  ice_candidates  JSONB DEFAULT '[]'::jsonb,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '1 hour')
);

-- push_subscriptions tablosu
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES public.users(id) ON DELETE CASCADE,
  subscription  JSONB NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ============================================================
-- 3. İNDEKSLER (Performans için)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users(username);
CREATE INDEX IF NOT EXISTS idx_users_device_id ON public.users(device_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON public.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON public.messages(receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON public.calls(callee_id, status);

-- ============================================================
-- 4. REALTIME (Canlı WebSocket dinleme)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.calls;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'users'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'friendships'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships;
  END IF;
END $$;

-- ============================================================
-- 5. ROW LEVEL SECURITY (RLS) POLİTİKALARI
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Mevcut politikaları temizle (tekrar çalıştırıldığında hata vermemesi için)
DROP POLICY IF EXISTS "allow_all_users" ON public.users;
DROP POLICY IF EXISTS "allow_all_friendships" ON public.friendships;
DROP POLICY IF EXISTS "allow_all_messages" ON public.messages;
DROP POLICY IF EXISTS "allow_all_calls" ON public.calls;
DROP POLICY IF EXISTS "allow_all_push" ON public.push_subscriptions;

-- VOYN istemcisi anonim / cihaz tabanlı çalıştığı için PostgREST politikaları
CREATE POLICY "allow_all_users" ON public.users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_friendships" ON public.friendships FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_messages" ON public.messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_calls" ON public.calls FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_push" ON public.push_subscriptions FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 6. STORAGE BUCKETS (Profil resimleri ve Medya)
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('avatars', 'avatars', true, 5242880)
ON CONFLICT (id) DO UPDATE SET public = true;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('media', 'media', true, 52428800)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Storage politikaları
DROP POLICY IF EXISTS "avatars_allow_all" ON storage.objects;
DROP POLICY IF EXISTS "media_allow_all" ON storage.objects;

CREATE POLICY "avatars_allow_all" ON storage.objects
  FOR ALL USING (bucket_id = 'avatars') WITH CHECK (bucket_id = 'avatars');

CREATE POLICY "media_allow_all" ON storage.objects
  FOR ALL USING (bucket_id = 'media') WITH CHECK (bucket_id = 'media');

-- ============================================================
-- 7. OTOMATİK GÜNCELLEME VE TEMİZLİK FONKSİYONLARI
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_users_updated_at ON public.users;
CREATE TRIGGER trigger_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Süresi dolmuş geçici mesajları temizleme fonksiyonu
CREATE OR REPLACE FUNCTION public.cleanup_expired_data()
RETURNS void AS $$
BEGIN
  -- Süresi dolmuş mesajları sil
  DELETE FROM public.messages WHERE expires_at < NOW();
  -- Süresi dolmuş çağrıları sil
  DELETE FROM public.calls WHERE expires_at < NOW();
  -- 5 dakikadır sinyal vermeyenleri offline yap
  UPDATE public.users SET is_online = false WHERE last_seen < NOW() - INTERVAL '5 minutes' AND is_online = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
