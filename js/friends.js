/**
 * VOYN Friends — Arkadaş sistemi
 * Kullanıcı arama, arkadaşlık istekleri, çevrimiçi durum izleme
 */

class VoynFriends {
  constructor(supabaseClient, db, auth) {
    this.supabase = supabaseClient;
    this.db = db;
    this.auth = auth;

    this._friendsList = [];
    this._presenceChannel = null;
    this._onPresenceCallbacks = [];
    this._onFriendRequestCallbacks = [];
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async init() {
    await this._loadFriendsFromServer();
    await this._subscribeToFriendRequests();
  }

  // ─── User Search ──────────────────────────────────────────────────────────

  /**
   * Kullanıcı adıyla kullanıcı ara
   * @param {string} query - Aranacak kullanıcı adı (kısmi eşleşme)
   * @returns {Array} kullanıcı listesi
   */
  async searchUser(query) {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Oturum açılmamış');

    query = query.trim().toLowerCase();
    if (query.length < 2) throw new Error('En az 2 karakter girin');

    const { data, error } = await this.supabase
      .from('users')
      .select('id, username, avatar_url, is_online, last_seen')
      .ilike('username', `%${query}%`)
      .neq('id', user.id)
      .limit(20);

    if (error) throw error;

    // Arkadaşlık durumlarını ekle
    return Promise.all(
      (data || []).map(async (u) => {
        const status = await this._getFriendshipStatus(u.id);
        return { ...u, friendshipStatus: status };
      })
    );
  }

  // ─── Friend Request ───────────────────────────────────────────────────────

  /**
   * Arkadaşlık isteği gönder
   * @param {string} toUserId
   */
  async sendFriendRequest(toUserId) {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Oturum açılmamış');
    if (toUserId === user.id) throw new Error('Kendine istek gönderilemez');

    // Zaten arkadaş mı veya istek var mı kontrol et
    const existing = await this._getFriendshipStatus(toUserId);
    if (existing === 'friends') throw new Error('Zaten arkadaşsınız');
    if (existing === 'request_sent') throw new Error('İstek zaten gönderildi');
    if (existing === 'request_received') {
      // Karşılıklı istek → isteği kabul et
      return this._acceptMutualRequest(toUserId);
    }

    const { data, error } = await this.supabase
      .from('friend_requests')
      .insert({
        from_user_id: user.id,
        to_user_id: toUserId,
        status: 'pending',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Gelen arkadaşlık isteğini kabul et
   * @param {string} requestId - friend_requests.id
   */
  async acceptRequest(requestId) {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Oturum açılmamış');

    // İsteği getir
    const { data: req, error: fetchErr } = await this.supabase
      .from('friend_requests')
      .select('*')
      .eq('id', requestId)
      .eq('to_user_id', user.id)
      .single();

    if (fetchErr || !req) throw new Error('İstek bulunamadı');
    if (req.status !== 'pending') throw new Error('İstek zaten işlendi');

    // İsteği güncelle
    const { error: updateErr } = await this.supabase
      .from('friend_requests')
      .update({ status: 'accepted', responded_at: new Date().toISOString() })
      .eq('id', requestId);

    if (updateErr) throw updateErr;

    // Arkadaşlık kaydı oluştur (her iki yönde)
    const { error: friendErr } = await this.supabase.from('friends').insert([
      {
        user_id: user.id,
        friend_id: req.from_user_id,
        created_at: new Date().toISOString(),
      },
      {
        user_id: req.from_user_id,
        friend_id: user.id,
        created_at: new Date().toISOString(),
      },
    ]);

    if (friendErr) throw friendErr;

    // Yerel listeyi güncelle
    await this._loadFriendsFromServer();
    return req;
  }

  /**
   * Gelen arkadaşlık isteğini reddet
   * @param {string} requestId
   */
  async rejectRequest(requestId) {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Oturum açılmamış');

    const { error } = await this.supabase
      .from('friend_requests')
      .update({ status: 'rejected', responded_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('to_user_id', user.id);

    if (error) throw error;
  }

  /**
   * Arkadaşlıktan çıkar
   * @param {string} friendUserId
   */
  async removeFriend(friendUserId) {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Oturum açılmamış');

    // Her iki yönden sil
    const { error } = await this.supabase
      .from('friends')
      .delete()
      .or(
        `and(user_id.eq.${user.id},friend_id.eq.${friendUserId}),and(user_id.eq.${friendUserId},friend_id.eq.${user.id})`
      );

    if (error) throw error;

    // Yerel listeden çıkar
    this._friendsList = this._friendsList.filter((f) => f.id !== friendUserId);
  }

  // ─── Friends List ─────────────────────────────────────────────────────────

  /**
   * Arkadaş listesini getir (sunucudan)
   * @returns {Array} kullanıcı nesneleri
   */
  async getFriendsList() {
    await this._loadFriendsFromServer();
    return this._friendsList;
  }

  async _loadFriendsFromServer() {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    const { data, error } = await this.supabase
      .from('friends')
      .select(`
        friend_id,
        users!friends_friend_id_fkey (
          id, username, avatar_url, is_online, last_seen, bio
        )
      `)
      .eq('user_id', user.id);

    if (error) {
      console.error('[VoynFriends] loadFriends error:', error);
      return;
    }

    this._friendsList = (data || [])
      .filter((row) => row.users)
      .map((row) => ({
        id: row.users.id,
        username: row.users.username,
        avatarUrl: row.users.avatar_url,
        isOnline: row.users.is_online,
        lastSeen: row.users.last_seen,
        bio: row.users.bio || '',
      }));

    // IndexedDB'ye kaydet
    await Promise.all(this._friendsList.map((f) => this.db.saveUser(f)));
  }

  // ─── Incoming Requests ────────────────────────────────────────────────────

  /**
   * Gelen bekleyen arkadaşlık isteklerini getir
   */
  async getPendingRequests() {
    const user = this.auth.getCurrentUser();
    if (!user) return [];

    const { data, error } = await this.supabase
      .from('friend_requests')
      .select(`
        id, created_at, status,
        from_user:users!friend_requests_from_user_id_fkey (
          id, username, avatar_url
        )
      `)
      .eq('to_user_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Gönderilen bekleyen istekleri getir
   */
  async getSentRequests() {
    const user = this.auth.getCurrentUser();
    if (!user) return [];

    const { data, error } = await this.supabase
      .from('friend_requests')
      .select(`
        id, created_at, status,
        to_user:users!friend_requests_to_user_id_fkey (
          id, username, avatar_url
        )
      `)
      .eq('from_user_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // ─── Online Status ────────────────────────────────────────────────────────

  /**
   * Birden fazla kullanıcının çevrimiçi durumunu izle (Supabase Realtime Presence)
   * @param {string[]} userIds
   */
  async getOnlineStatus(userIds) {
    if (!userIds || userIds.length === 0) return {};

    const { data, error } = await this.supabase
      .from('users')
      .select('id, is_online, last_seen')
      .in('id', userIds);

    if (error) throw error;

    const result = {};
    (data || []).forEach((u) => {
      result[u.id] = { isOnline: u.is_online, lastSeen: u.last_seen };
    });
    return result;
  }

  /**
   * Realtime presence kanalıyla anlık durum izle
   * @param {string[]} userIds
   */
  subscribeToPresence(userIds) {
    if (this._presenceChannel) {
      this.supabase.removeChannel(this._presenceChannel);
    }

    this._presenceChannel = this.supabase
      .channel('presence:friends')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'users',
          filter: `id=in.(${userIds.join(',')})`,
        },
        (payload) => {
          this._onPresenceCallbacks.forEach((cb) =>
            cb(payload.new.id, {
              isOnline: payload.new.is_online,
              lastSeen: payload.new.last_seen,
            })
          );
        }
      )
      .subscribe();
  }

  unsubscribePresence() {
    if (this._presenceChannel) {
      this.supabase.removeChannel(this._presenceChannel);
      this._presenceChannel = null;
    }
  }

  onPresenceChange(callback) {
    this._onPresenceCallbacks.push(callback);
    return () => {
      this._onPresenceCallbacks = this._onPresenceCallbacks.filter((c) => c !== callback);
    };
  }

  // ─── Realtime friend requests ─────────────────────────────────────────────

  async _subscribeToFriendRequests() {
    const user = this.auth.getCurrentUser();
    if (!user) return;

    this.supabase
      .channel(`friend_requests:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'friend_requests',
          filter: `to_user_id=eq.${user.id}`,
        },
        (payload) => {
          this._onFriendRequestCallbacks.forEach((cb) => cb(payload.new));
        }
      )
      .subscribe();
  }

  onFriendRequest(callback) {
    this._onFriendRequestCallbacks.push(callback);
    return () => {
      this._onFriendRequestCallbacks = this._onFriendRequestCallbacks.filter(
        (c) => c !== callback
      );
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * İki kullanıcı arasındaki arkadaşlık durumunu getir
   * @returns {'none'|'request_sent'|'request_received'|'friends'}
   */
  async _getFriendshipStatus(otherUserId) {
    const user = this.auth.getCurrentUser();
    if (!user) return 'none';

    // Arkadaş mı?
    const { data: friendship } = await this.supabase
      .from('friends')
      .select('id')
      .eq('user_id', user.id)
      .eq('friend_id', otherUserId)
      .maybeSingle();

    if (friendship) return 'friends';

    // İstek gönderildi mi?
    const { data: sent } = await this.supabase
      .from('friend_requests')
      .select('id')
      .eq('from_user_id', user.id)
      .eq('to_user_id', otherUserId)
      .eq('status', 'pending')
      .maybeSingle();

    if (sent) return 'request_sent';

    // İstek alındı mı?
    const { data: received } = await this.supabase
      .from('friend_requests')
      .select('id')
      .eq('from_user_id', otherUserId)
      .eq('to_user_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (received) return 'request_received';

    return 'none';
  }

  /**
   * Karşılıklı istek → her ikisi de istek göndermiş, isteği otomatik kabul et
   */
  async _acceptMutualRequest(fromUserId) {
    const user = this.auth.getCurrentUser();

    const { data: req } = await this.supabase
      .from('friend_requests')
      .select('id')
      .eq('from_user_id', fromUserId)
      .eq('to_user_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();

    if (req) {
      return this.acceptRequest(req.id);
    }
  }

  isFriend(userId) {
    return this._friendsList.some((f) => f.id === userId);
  }

  getFriendById(userId) {
    return this._friendsList.find((f) => f.id === userId) || null;
  }
}
