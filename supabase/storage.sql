-- ============================================================
-- VOYN PWA - Supabase Storage Bucket Setup
-- ============================================================
-- Apply AFTER schema.sql and rls.sql
-- Run in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- BUCKETS
-- ============================================================

-- avatars bucket (herkese açık, profil fotoğrafları)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  5242880,  -- 5 MB limit
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public              = EXCLUDED.public,
  file_size_limit     = EXCLUDED.file_size_limit,
  allowed_mime_types  = EXCLUDED.allowed_mime_types;

-- media bucket (özel, medya dosyaları: video/ses/dosya)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media',
  'media',
  false,
  52428800,  -- 50 MB limit
  ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/aac',
    'application/pdf',
    'application/zip',
    'application/octet-stream',
    'text/plain'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public              = EXCLUDED.public,
  file_size_limit     = EXCLUDED.file_size_limit,
  allowed_mime_types  = EXCLUDED.allowed_mime_types;

-- ============================================================
-- STORAGE POLICIES - AVATARS (public bucket)
-- ============================================================

-- Herkes avatar görüntüleyebilir
CREATE POLICY "avatars_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- Kullanıcı yalnızca kendi avatar klasörüne yükleyebilir
-- Dosya yolu: avatars/{user_id}/{filename}
CREATE POLICY "avatars_insert_own"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (
      SELECT id::TEXT FROM users
      WHERE device_id = current_setting('app.device_id', true)
    )
  );

-- Kullanıcı yalnızca kendi avatarını güncelleyebilir
CREATE POLICY "avatars_update_own"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (
      SELECT id::TEXT FROM users
      WHERE device_id = current_setting('app.device_id', true)
    )
  );

-- Kullanıcı yalnızca kendi avatarını silebilir
CREATE POLICY "avatars_delete_own"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (
      SELECT id::TEXT FROM users
      WHERE device_id = current_setting('app.device_id', true)
    )
  );

-- ============================================================
-- STORAGE POLICIES - MEDIA (private bucket)
-- ============================================================

-- Medya yalnızca conversation katılımcıları tarafından görüntülenebilir
-- Dosya yolu: media/{conversation_id}/{filename}
-- Kullanıcı conversation'ın tarafıysa erişebilir
CREATE POLICY "media_select_participants"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'media'
    AND EXISTS (
      SELECT 1 FROM messages m
      WHERE m.conversation_id = (storage.foldername(name))[1]
        AND (
          m.sender_id   = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
          OR
          m.receiver_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
        )
    )
  );

-- Medya yalnızca mesaj göndericisi tarafından yüklenebilir
-- Dosya yolu: media/{conversation_id}/{sender_id}/{filename}
CREATE POLICY "media_insert_sender"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'media'
    AND (storage.foldername(name))[2] = (
      SELECT id::TEXT FROM users
      WHERE device_id = current_setting('app.device_id', true)
    )
  );

-- Medya dosyası yalnızca yükleyen tarafından silinebilir
CREATE POLICY "media_delete_owner"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'media'
    AND (storage.foldername(name))[2] = (
      SELECT id::TEXT FROM users
      WHERE device_id = current_setting('app.device_id', true)
    )
  );

-- ============================================================
-- HELPER FUNCTION: Orphan Media Cleanup
-- ============================================================
-- Silinmiş mesajlara ait medya dosyalarını temizle (Edge Function'dan çağrılır)
CREATE OR REPLACE FUNCTION cleanup_orphan_media()
RETURNS void AS $$
DECLARE
  orphan_record RECORD;
BEGIN
  FOR orphan_record IN
    SELECT name
    FROM storage.objects
    WHERE bucket_id = 'media'
      AND created_at < NOW() - INTERVAL '8 days'  -- mesaj TTL + 1 gün tampon
  LOOP
    -- Orphan dosyayı sil (mesaj tablosunda karşılığı yok)
    IF NOT EXISTS (
      SELECT 1 FROM messages
      WHERE file_url LIKE '%' || orphan_record.name || '%'
    ) THEN
      DELETE FROM storage.objects WHERE name = orphan_record.name AND bucket_id = 'media';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
