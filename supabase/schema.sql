-- ============================================================
-- VOYN PWA - Supabase Database Schema
-- ============================================================
-- Apply this file in Supabase SQL Editor (order matters)
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- ============================================================
-- TABLES
-- ============================================================

-- users tablosu
CREATE TABLE IF NOT EXISTS users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username        TEXT        UNIQUE NOT NULL
                              CHECK (length(username) >= 3 AND length(username) <= 30),
  device_id       TEXT        UNIQUE NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  bio             TEXT,
  is_online       BOOLEAN     DEFAULT false,
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  push_subscription JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- friendships tablosu
CREATE TABLE IF NOT EXISTS friendships (
  id            UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  UUID  REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  UUID  REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT  CHECK (status IN ('pending', 'accepted', 'blocked')) DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(requester_id, addressee_id)
);

-- messages tablosu (geçici, teslimat sonrası silinecek)
CREATE TABLE IF NOT EXISTS messages (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT    NOT NULL,
  sender_id       UUID    REFERENCES users(id) ON DELETE CASCADE,
  receiver_id     UUID    REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT,
  type            TEXT    CHECK (type IN ('text', 'image', 'video', 'file', 'audio', 'call')) DEFAULT 'text',
  file_url        TEXT,
  file_name       TEXT,
  file_size       BIGINT,
  status          TEXT    CHECK (status IN ('sent', 'delivered', 'read')) DEFAULT 'sent',
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- calls tablosu (WebRTC signaling için)
CREATE TABLE IF NOT EXISTS calls (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id       UUID    REFERENCES users(id) ON DELETE CASCADE,
  callee_id       UUID    REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT    CHECK (type IN ('audio', 'video')) DEFAULT 'audio',
  status          TEXT    CHECK (status IN ('ringing', 'answered', 'rejected', 'ended', 'missed')) DEFAULT 'ringing',
  offer           JSONB,
  answer          JSONB,
  ice_candidates  JSONB   DEFAULT '[]',
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '1 hour')
);

-- push_subscriptions tablosu
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID  REFERENCES users(id) ON DELETE CASCADE,
  subscription  JSONB NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ============================================================
-- INDEXES
-- ============================================================

-- users
CREATE INDEX IF NOT EXISTS idx_users_username    ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_device_id   ON users (device_id);
CREATE INDEX IF NOT EXISTS idx_users_is_online   ON users (is_online);
CREATE INDEX IF NOT EXISTS idx_users_last_seen   ON users (last_seen);

-- friendships
CREATE INDEX IF NOT EXISTS idx_friendships_requester  ON friendships (requester_id);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee  ON friendships (addressee_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status     ON friendships (status);

-- messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation  ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender        ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver      ON messages (receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at    ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at    ON messages (expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_status        ON messages (status);

-- calls
CREATE INDEX IF NOT EXISTS idx_calls_caller     ON calls (caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee     ON calls (callee_id);
CREATE INDEX IF NOT EXISTS idx_calls_status     ON calls (status);
CREATE INDEX IF NOT EXISTS idx_calls_expires_at ON calls (expires_at);

-- push_subscriptions
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

-- ============================================================
-- TRIGGERS & FUNCTIONS
-- ============================================================

-- Auto-update updated_at on users
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- conversation_id üretici (iki kullanıcı arasında deterministik)
-- Kullanım: SELECT generate_conversation_id('uuid-a', 'uuid-b')
CREATE OR REPLACE FUNCTION generate_conversation_id(user_a UUID, user_b UUID)
RETURNS TEXT AS $$
BEGIN
  IF user_a < user_b THEN
    RETURN user_a::TEXT || '_' || user_b::TEXT;
  ELSE
    RETURN user_b::TEXT || '_' || user_a::TEXT;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Kullanıcı çevrimiçi durumunu güncelle
CREATE OR REPLACE FUNCTION set_user_offline(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE users
  SET is_online = false, last_seen = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Süresi dolmuş mesajları temizle
CREATE OR REPLACE FUNCTION cleanup_expired_messages()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM messages WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Süresi dolmuş çağrıları temizle
CREATE OR REPLACE FUNCTION cleanup_expired_calls()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Önce 'ringing' veya 'answered' durumunda olanları 'ended' yap
  UPDATE calls
  SET status = 'ended', ended_at = NOW()
  WHERE expires_at < NOW()
    AND status IN ('ringing', 'answered');

  -- Sonra tümünü sil
  DELETE FROM calls WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Uzun süredir görülmemiş kullanıcıları çevrimdışı yap (5 dakika eşik)
CREATE OR REPLACE FUNCTION cleanup_stale_online_status()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE users
  SET is_online = false
  WHERE is_online = true
    AND last_seen < NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- REALTIME
-- ============================================================

-- Realtime için publication'a ekle
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE calls;
ALTER PUBLICATION supabase_realtime ADD TABLE users;
ALTER PUBLICATION supabase_realtime ADD TABLE friendships;
