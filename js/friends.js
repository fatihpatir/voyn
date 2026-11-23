/**
 * VOYN Friends — Arkadaş & Kullanıcı Yönetimi
 * Kullanıcı arama, arkadaş ekleme, kişi listesi ve çevrimiçi durumu
 */

class VoynFriends {
  constructor(supabaseClient, db, auth) {
    this.supabase = supabaseClient;
    this.db = db;
    this.auth = auth;
    this._friendsList = [];
    this._friendsMap = new Map();
  }

  // ─── Kullanıcı Arama ───────────────────────────────────────────────────────

  /**
   * Kullanıcı adıyla arama yap
   * @param {string} query
   * @returns {Promise<Array>}
   */
  async searchUser(query) {
    const currentUser = this.auth.getCurrentUser();
    if (!currentUser) throw new Error('Oturum açılmamış');

    query = (query || '').trim().toLowerCase();
    if (query.length < 1) return [];

    const { data, error } = await this.supabase
      .from('users')
      .select('id, username, display_name, avatar_url, is_online, last_seen')
      .ilike('username', `%${query}%`)
      .neq('id', currentUser.id)
      .limit(20);

    if (error) {
      console.error('[VoynFriends] Arama hatası:', error);
      throw error;
    }

    return (data || []).map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name || u.username,
      avatarUrl: u.avatar_url || null,
      isOnline: Boolean(u.is_online),
      lastSeen: u.last_seen || null,
    }));
  }

  // ─── Arkadaş / Kişi Ekleme ─────────────────────────────────────────────────

  /**
   * Bir kullanıcıyı arkadaş olarak ekle ve yerel depoya kaydet
   * @param {object|string} userOrId
   * @returns {Promise<object>}
   */
  async addFriend(userOrId) {
    const currentUser = this.auth.getCurrentUser();
    if (!currentUser) throw new Error('Oturum açılmamış');

    let targetUser = userOrId;
    if (typeof userOrId === 'string') {
      const { data } = await this.supabase
        .from('users')
        .select('id, username, display_name, avatar_url, is_online, last_seen')
        .eq('id', userOrId)
        .single();
      targetUser = data;
    }

    if (!targetUser) throw new Error('Kullanıcı bulunamadı');

    // Supabase friendships tablosuna ekle
    try {
      await this.supabase
        .from('friendships')
        .upsert(
          {
            requester_id: currentUser.id,
            addressee_id: targetUser.id,
            status: 'accepted',
            created_at: new Date().toISOString(),
          },
          { onConflict: 'requester_id,addressee_id' }
        );
    } catch (err) {
      console.warn('[VoynFriends] Friendship kaydı uyarısı:', err);
    }

    // Yerel IndexedDB'ye kaydet
    const friendObj = {
      id: targetUser.id,
      username: targetUser.username,
      displayName: targetUser.displayName || targetUser.display_name || targetUser.username,
      avatarUrl: targetUser.avatarUrl || targetUser.avatar_url || null,
      isOnline: Boolean(targetUser.isOnline || targetUser.is_online),
      lastSeen: targetUser.lastSeen || targetUser.last_seen || null,
      updatedAt: new Date().toISOString(),
    };

    if (this.db) {
      await this.db.saveUser(friendObj);
    }

    this._friendsMap.set(friendObj.id, friendObj);
    return friendObj;
  }

  // ─── Arkadaş Listesi ───────────────────────────────────────────────────────

  /**
   * Arkadaş listesini getir
   */
  async getFriendsList() {
    const currentUser = this.auth.getCurrentUser();
    if (!currentUser) return [];

    try {
      const { data: friendships, error } = await this.supabase
        .from('friendships')
        .select('requester_id, addressee_id, status')
        .or(`requester_id.eq.${currentUser.id},addressee_id.eq.${currentUser.id}`);

      if (error) {
        console.warn('[VoynFriends] Arkadaş listesi çekilemedi:', error);
      } else if (friendships && friendships.length > 0) {
        const friendIds = friendships.map((f) =>
          f.requester_id === currentUser.id ? f.addressee_id : f.requester_id
        );

        if (friendIds.length > 0) {
          const { data: userRows } = await this.supabase
            .from('users')
            .select('id, username, display_name, avatar_url, is_online, last_seen')
            .in('id', friendIds);

          if (userRows) {
            userRows.forEach((u) => {
              const obj = {
                id: u.id,
                username: u.username,
                displayName: u.display_name || u.username,
                avatarUrl: u.avatar_url,
                isOnline: u.is_online,
                lastSeen: u.last_seen,
              };
              this._friendsMap.set(u.id, obj);
              if (this.db) this.db.saveUser(obj);
            });
          }
        }
      }
    } catch (e) {
      console.warn('[VoynFriends] loadFriends catch:', e);
    }

    this._friendsList = Array.from(this._friendsMap.values());
    return this._friendsList;
  }

  getFriendById(userId) {
    return this._friendsMap.get(userId) || null;
  }

  unsubscribePresence() {
    // presence cleanup
  }
}
