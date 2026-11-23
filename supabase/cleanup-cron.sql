-- ============================================================
-- VOYN PWA - Automated Cleanup Cron Jobs
-- ============================================================
-- Requires: pg_cron extension (enabled in Supabase Pro plans)
-- Apply AFTER schema.sql
-- ============================================================

-- Enable pg_cron if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================================
-- CRON JOB 1: Süresi dolmuş mesajları temizle
-- Her saat başı çalışır
-- ============================================================
SELECT cron.schedule(
  'cleanup-expired-messages',   -- job adı
  '0 * * * *',                  -- her saat başı
  $$
    DO $$
    DECLARE
      deleted_count INTEGER;
    BEGIN
      DELETE FROM messages WHERE expires_at < NOW();
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      RAISE NOTICE 'Cleaned up % expired messages at %', deleted_count, NOW();
    END;
    $$;
  $$
);

-- ============================================================
-- CRON JOB 2: Süresi dolmuş çağrıları temizle
-- Her 15 dakikada bir çalışır
-- ============================================================
SELECT cron.schedule(
  'cleanup-expired-calls',
  '*/15 * * * *',              -- her 15 dakikada bir
  $$
    DO $$
    DECLARE
      updated_count INTEGER;
      deleted_count INTEGER;
    BEGIN
      -- Aktif ama süresi dolmuş çağrıları bitmiş olarak işaretle
      UPDATE calls
      SET status = 'ended', ended_at = NOW()
      WHERE expires_at < NOW()
        AND status IN ('ringing', 'answered');
      GET DIAGNOSTICS updated_count = ROW_COUNT;

      -- Hepsini sil
      DELETE FROM calls WHERE expires_at < NOW();
      GET DIAGNOSTICS deleted_count = ROW_COUNT;

      RAISE NOTICE 'Updated % stale calls, deleted % expired calls at %',
        updated_count, deleted_count, NOW();
    END;
    $$;
  $$
);

-- ============================================================
-- CRON JOB 3: Stale online status temizle
-- Her 5 dakikada bir: 5+ dakika sessiz kullanıcıları offline yap
-- ============================================================
SELECT cron.schedule(
  'cleanup-stale-online-status',
  '*/5 * * * *',               -- her 5 dakikada bir
  $$
    DO $$
    DECLARE
      updated_count INTEGER;
    BEGIN
      UPDATE users
      SET is_online = false
      WHERE is_online = true
        AND last_seen < NOW() - INTERVAL '5 minutes';
      GET DIAGNOSTICS updated_count = ROW_COUNT;

      IF updated_count > 0 THEN
        RAISE NOTICE 'Marked % users as offline at %', updated_count, NOW();
      END IF;
    END;
    $$;
  $$
);

-- ============================================================
-- CRON JOB 4: Haftalık derin temizlik
-- Her Pazar gece yarısı: orphan kayıtları temizle
-- ============================================================
SELECT cron.schedule(
  'weekly-deep-cleanup',
  '0 0 * * 0',                 -- Her Pazar 00:00 UTC
  $$
    DO $$
    DECLARE
      deleted_friendships INTEGER;
      deleted_push INTEGER;
    BEGIN
      -- Kullanıcısı silinmiş orphan friendship kayıtları (cascade ile silindi ama kontrol)
      DELETE FROM friendships
      WHERE requester_id NOT IN (SELECT id FROM users)
         OR addressee_id NOT IN (SELECT id FROM users);
      GET DIAGNOSTICS deleted_friendships = ROW_COUNT;

      -- Kullanıcısı olmayan push subscriptions
      DELETE FROM push_subscriptions
      WHERE user_id NOT IN (SELECT id FROM users);
      GET DIAGNOSTICS deleted_push = ROW_COUNT;

      RAISE NOTICE 'Weekly cleanup: % orphan friendships, % orphan push subscriptions removed at %',
        deleted_friendships, deleted_push, NOW();
    END;
    $$;
  $$
);

-- ============================================================
-- CRON JOB 5: Okunmuş mesajları erken sil
-- Her gün gece yarısı: 24 saatten fazla önce okunmuş mesajları sil
-- (7 günlük TTL beklemeden yer açmak için)
-- ============================================================
SELECT cron.schedule(
  'cleanup-read-messages',
  '0 0 * * *',                 -- Her gün 00:00 UTC
  $$
    DO $$
    DECLARE
      deleted_count INTEGER;
    BEGIN
      DELETE FROM messages
      WHERE status = 'read'
        AND read_at < NOW() - INTERVAL '24 hours';
      GET DIAGNOSTICS deleted_count = ROW_COUNT;

      RAISE NOTICE 'Cleaned up % read messages at %', deleted_count, NOW();
    END;
    $$;
  $$
);

-- ============================================================
-- CRON JOB YÖNETIMI
-- ============================================================

-- Mevcut cron job'ları listele:
-- SELECT * FROM cron.job;

-- Job'ı durdur:
-- SELECT cron.unschedule('cleanup-expired-messages');

-- Job geçmişini gör:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- ============================================================
-- ALTERNATIF: pg_cron kullanılamıyorsa (Free Plan)
-- Supabase Edge Function + GitHub Actions ile zamanlama:
-- ============================================================
-- Aşağıdaki SQL fonksiyonlarını Edge Function'dan HTTP ile çağır:

-- Manuel temizlik fonksiyonu (HTTP endpoint üzerinden tetiklenebilir)
CREATE OR REPLACE FUNCTION run_all_cleanups()
RETURNS JSONB AS $$
DECLARE
  result JSONB;
  msg_count INTEGER;
  call_count INTEGER;
  user_count INTEGER;
BEGIN
  -- Mesajları temizle
  DELETE FROM messages WHERE expires_at < NOW();
  GET DIAGNOSTICS msg_count = ROW_COUNT;

  -- Çağrıları temizle
  UPDATE calls SET status = 'ended', ended_at = NOW()
  WHERE expires_at < NOW() AND status IN ('ringing', 'answered');
  DELETE FROM calls WHERE expires_at < NOW();
  GET DIAGNOSTICS call_count = ROW_COUNT;

  -- Offline durumu güncelle
  UPDATE users SET is_online = false
  WHERE is_online = true AND last_seen < NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS user_count = ROW_COUNT;

  result := jsonb_build_object(
    'expired_messages_deleted', msg_count,
    'expired_calls_deleted', call_count,
    'users_marked_offline', user_count,
    'run_at', NOW()
  );

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Bu fonksiyonu Edge Function üzerinden çağırmak için:
-- const { data } = await supabase.rpc('run_all_cleanups');
