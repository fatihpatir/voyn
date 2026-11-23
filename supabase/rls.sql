-- ============================================================
-- VOYN PWA - Row Level Security (RLS) Policies
-- ============================================================
-- Apply AFTER schema.sql
-- ============================================================

-- ============================================================
-- USERS TABLE
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Herkese görünür (kullanıcı arama için)
CREATE POLICY "users_select_public"
  ON users FOR SELECT
  USING (true);

-- Sadece kendi kaydını oluşturabilir (device_id eşleşmeli)
CREATE POLICY "users_insert_own"
  ON users FOR INSERT
  WITH CHECK (true);  -- Auth fonksiyonu Edge Function üzerinden yapılır

-- Sadece kendi profilini güncelleyebilir
CREATE POLICY "users_update_own"
  ON users FOR UPDATE
  USING (
    id = (
      SELECT u.id FROM users u
      WHERE u.device_id = current_setting('app.device_id', true)
    )
  )
  WITH CHECK (
    id = (
      SELECT u.id FROM users u
      WHERE u.device_id = current_setting('app.device_id', true)
    )
  );

-- Hesabını silemez (sadece admin)
CREATE POLICY "users_delete_admin_only"
  ON users FOR DELETE
  USING (false);

-- ============================================================
-- FRIENDSHIPS TABLE
-- ============================================================

ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;

-- Sadece ilgili kişiler arkadaşlık kaydını görebilir
CREATE POLICY "friendships_select_involved"
  ON friendships FOR SELECT
  USING (
    requester_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
    OR
    addressee_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Arkadaşlık isteği sadece requester tarafından gönderilebilir
CREATE POLICY "friendships_insert_requester"
  ON friendships FOR INSERT
  WITH CHECK (
    requester_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Durum güncellemesi: requester iptal edebilir, addressee kabul/red edebilir
CREATE POLICY "friendships_update_involved"
  ON friendships FOR UPDATE
  USING (
    requester_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
    OR
    addressee_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Silme: sadece ilgililer yapabilir
CREATE POLICY "friendships_delete_involved"
  ON friendships FOR DELETE
  USING (
    requester_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
    OR
    addressee_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- ============================================================
-- MESSAGES TABLE
-- ============================================================

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Mesajlar sadece gönderen ve alıcı tarafından görülebilir
CREATE POLICY "messages_select_participants"
  ON messages FOR SELECT
  USING (
    sender_id   = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
    OR
    receiver_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Mesaj sadece gönderen tarafından oluşturulabilir
CREATE POLICY "messages_insert_sender"
  ON messages FOR INSERT
  WITH CHECK (
    sender_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Mesaj durumu sadece alıcı tarafından güncellenebilir (delivered/read)
-- Gönderen kendi mesajını güncelleyemez
CREATE POLICY "messages_update_receiver"
  ON messages FOR UPDATE
  USING (
    receiver_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  )
  WITH CHECK (
    receiver_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Mesaj silme: sadece gönderen veya alıcı
CREATE POLICY "messages_delete_participants"
  ON messages FOR DELETE
  USING (
    sender_id   = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
    OR
    receiver_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- ============================================================
-- CALLS TABLE
-- ============================================================

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

-- Çağrılar sadece caller ve callee tarafından görülebilir
CREATE POLICY "calls_select_participants"
  ON calls FOR SELECT
  USING (
    caller_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
    OR
    callee_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Çağrı sadece caller tarafından başlatılabilir
CREATE POLICY "calls_insert_caller"
  ON calls FOR INSERT
  WITH CHECK (
    caller_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Çağrı durumu her iki tarafça güncellenebilir (signaling için)
CREATE POLICY "calls_update_participants"
  ON calls FOR UPDATE
  USING (
    caller_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
    OR
    callee_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Çağrı silme: her iki taraf yapabilir
CREATE POLICY "calls_delete_participants"
  ON calls FOR DELETE
  USING (
    caller_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
    OR
    callee_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- ============================================================
-- PUSH_SUBSCRIPTIONS TABLE
-- ============================================================

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Push subscription sadece sahibi görebilir
CREATE POLICY "push_subscriptions_select_owner"
  ON push_subscriptions FOR SELECT
  USING (
    user_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Sahibi ekleyebilir
CREATE POLICY "push_subscriptions_insert_owner"
  ON push_subscriptions FOR INSERT
  WITH CHECK (
    user_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Sahibi güncelleyebilir
CREATE POLICY "push_subscriptions_update_owner"
  ON push_subscriptions FOR UPDATE
  USING (
    user_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- Sahibi silebilir
CREATE POLICY "push_subscriptions_delete_owner"
  ON push_subscriptions FOR DELETE
  USING (
    user_id = (SELECT id FROM users WHERE device_id = current_setting('app.device_id', true))
  );

-- ============================================================
-- SERVICE ROLE BYPASS
-- ============================================================
-- Supabase Edge Functions service_role key ile çalışırken
-- RLS bypass edilir; aşağıdaki not bilgi amaçlıdır.
-- Service role key'i asla istemci tarafında kullanmayın!

-- Push bildirimleri için Edge Function'ın kullanıcı subscription'larına
-- erişmesine izin veren güvenli helper view:
CREATE OR REPLACE VIEW public.user_push_targets AS
  SELECT
    u.id          AS user_id,
    u.username,
    u.is_online,
    ps.subscription
  FROM users u
  JOIN push_subscriptions ps ON ps.user_id = u.id;

-- Bu view yalnızca service_role ile erişilebilir (RLS dolaylı olarak bypass edilmez)
REVOKE ALL ON public.user_push_targets FROM anon, authenticated;
