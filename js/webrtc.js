/**
 * VOYN WebRTC - Sesli ve Görüntülü Arama Sistemi
 * Supabase Realtime Broadcast + `calls` tablosu ile ultra-hızlı signaling.
 */

class VoynWebRTC {
  constructor(supabaseClient, authService) {
    this.supabase = supabaseClient;
    this.auth = authService;
    this.currentUser = null;

    // RTCPeerConnection instance
    this.peerConnection = null;

    // MediaStream referansları
    this.localStream = null;
    this.remoteStream = null;

    // Aktif arama bilgileri
    this.activeCallId = null;
    this.activeCallType = 'audio'; // 'audio' | 'video'
    this.activeCallTarget = null;
    this.activeCallerName = null;
    this.isInitiator = false;

    // Bekleyen ICE adayları
    this.pendingCandidates = [];

    // Realtime kanalları
    this.userSignalChannel = null;
    this.callRoomChannel = null;
    this.callDbSubscription = null;

    // Durum
    this.isMuted = false;
    this.isVideoOff = false;
    this.connectionState = 'idle'; // idle | calling | ringing | connected | ended

    // ICE Yapılandırması (STUN + TURN)
    this.iceConfig = {
      iceServers: [
        ...(typeof VOYN_CONFIG !== 'undefined' ? VOYN_CONFIG.STUN_SERVERS : [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ]),
        ...(typeof VOYN_CONFIG !== 'undefined' ? VOYN_CONFIG.TURN_SERVERS : [
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
        ]),
      ],
      iceCandidatePoolSize: 10,
    };

    // Callback fonksiyonları
    this.onIncomingCall = null;      // (callData) => void
    this.onCallConnected = null;     // () => void
    this.onCallEnded = null;         // (reason) => void
    this.onError = null;             // (error) => void
  }

  /**
   * Aktif kullanıcıyı ayarla ve sinyal dinlemeyi başlat
   */
  setUser(user) {
    this.currentUser = user;
    if (user && user.id) {
      this._listenForIncomingCalls();
    }
  }

  _getCurrentUser() {
    if (this.currentUser) return this.currentUser;
    if (this.auth && typeof this.auth.getCurrentUser === 'function') {
      this.currentUser = this.auth.getCurrentUser();
    }
    return this.currentUser;
  }

  /* ─────────────────────────── PUBLIC API ─────────────────────────── */

  /**
   * Arama başlat (Sesli veya Görüntülü)
   */
  async startCall(targetUserId, type = 'audio', targetUserName = '') {
    try {
      const user = this._getCurrentUser();
      if (!user) throw new Error('Arama yapmak için oturum açılmalıdır.');

      if (this.connectionState !== 'idle') {
        throw new Error('Zaten aktif bir görüşme devam ediyor.');
      }

      this.isInitiator = true;
      this.activeCallType = type;
      this.activeCallTarget = targetUserId;
      this.activeCallerName = targetUserName || 'Kullanıcı';
      this.connectionState = 'calling';

      // 1. Yerel medyayı hazırla
      await this._getLocalMedia(type);

      // 2. UUID call ID üret
      const callId = crypto.randomUUID();
      this.activeCallId = callId;

      // 3. UI güncelle ve giden arama bekleme sesini çal
      this._updateCallScreenUI('calling', this.activeCallerName, type);
      if (window.voynSound) {
        window.voynSound.startOutgoingTone();
      }

      // 4. Arama odasına katıl
      await this._joinCallRoom(callId);

      // 5. Calls tablosuna kaydet
      await this.supabase.from('calls').insert({
        id: callId,
        caller_id: user.id,
        callee_id: targetUserId,
        type: type,
        status: 'ringing',
        started_at: new Date().toISOString(),
      });

      // 6. Hedef kullanıcının kişisel kanalına Realtime Broadcast gönder
      const targetChannel = this.supabase.channel(`user-calls:${targetUserId}`);
      targetChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          targetChannel.send({
            type: 'broadcast',
            event: 'incoming_call',
            payload: {
              callId,
              callerId: user.id,
              callerName: user.displayName || user.username || 'VOYN Kullanıcısı',
              callType: type,
            },
          });
        }
      });

      // 7. Zaman aşımı (45 sn cevap verilmezse)
      this._startCallTimeout(45000);

    } catch (err) {
      console.error('[WebRTC] startCall hatası:', err);
      this._handleError('startCall', err);
      await this._cleanupCall('error');
    }
  }

  /**
   * Gelen aramayı cevapla
   */
  async answerCall(callId) {
    try {
      if (window.voynSound) {
        window.voynSound.stopRingtone();
      }

      this.activeCallId = callId;
      this.isInitiator = false;
      this.connectionState = 'connecting';

      // 1. Yerel medyayı hazırla
      await this._getLocalMedia(this.activeCallType);

      // 2. UI güncelle
      this._updateCallScreenUI('connected', this.activeCallerName, this.activeCallType);

      // 3. Çağrı odasına katıl
      await this._joinCallRoom(callId);

      // 4. RTCPeerConnection oluştur
      await this._createPeerConnection();

      // 5. Veritabanında arama durumunu güncelle
      await this.supabase
        .from('calls')
        .update({ status: 'answered' })
        .eq('id', callId);

      // 6. Odadaki diğer tarafa hazır olduğumuzu bildir (hazır olunca arayan offer gönderecek)
      if (this.callRoomChannel) {
        this.callRoomChannel.send({
          type: 'broadcast',
          event: 'callee_ready',
          payload: { callId },
        });
      }

    } catch (err) {
      console.error('[WebRTC] answerCall hatası:', err);
      this._handleError('answerCall', err);
      await this._cleanupCall('error');
    }
  }

  /**
   * Gelen aramayı reddet
   */
  async rejectCall(callId) {
    try {
      if (window.voynSound) {
        window.voynSound.stopRingtone();
      }

      const id = callId || this.activeCallId;
      if (id) {
        await this.supabase
          .from('calls')
          .update({ status: 'rejected', ended_at: new Date().toISOString() })
          .eq('id', id);

        if (this.callRoomChannel) {
          this.callRoomChannel.send({
            type: 'broadcast',
            event: 'call_rejected',
            payload: { callId: id },
          });
        }
      }

      await this._cleanupCall('rejected');
    } catch (err) {
      console.warn('[WebRTC] rejectCall:', err);
      await this._cleanupCall('rejected');
    }
  }

  /**
   * Aktif aramayı sonlandır
   */
  async endCall() {
    try {
      if (window.voynSound) {
        window.voynSound.stopOutgoingTone();
        window.voynSound.stopRingtone();
      }

      if (this.activeCallId) {
        await this.supabase
          .from('calls')
          .update({ status: 'ended', ended_at: new Date().toISOString() })
          .eq('id', this.activeCallId);

        if (this.callRoomChannel) {
          this.callRoomChannel.send({
            type: 'broadcast',
            event: 'call_ended',
            payload: { callId: this.activeCallId },
          });
        }
      }

      await this._cleanupCall('ended');
    } catch (err) {
      console.warn('[WebRTC] endCall:', err);
      await this._cleanupCall('ended');
    }
  }

  /**
   * Mikrofon Aç/Kapat
   */
  toggleMute() {
    if (!this.localStream) return false;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach((t) => {
      t.enabled = !this.isMuted;
    });

    const muteBtn = document.getElementById('btn-mute');
    if (muteBtn) {
      muteBtn.classList.toggle('active', this.isMuted);
      muteBtn.style.background = this.isMuted ? 'var(--color-danger, #ef4444)' : '';
    }
    return this.isMuted;
  }

  /**
   * Kamera Aç/Kapat
   */
  toggleVideo() {
    if (!this.localStream) return false;
    this.isVideoOff = !this.isVideoOff;
    this.localStream.getVideoTracks().forEach((t) => {
      t.enabled = !this.isVideoOff;
    });
    return this.isVideoOff;
  }

  /* ─────────────────────────── SIGNALING & ROOM ─────────────────────── */

  _listenForIncomingCalls() {
    const user = this._getCurrentUser();
    if (!user || !user.id) return;

    if (this.userSignalChannel) {
      this.supabase.removeChannel(this.userSignalChannel);
    }

    // 1. Realtime Broadcast ile gelen aramaları dinle (anlık)
    this.userSignalChannel = this.supabase
      .channel(`user-calls:${user.id}`)
      .on('broadcast', { event: 'incoming_call' }, (evt) => {
        const payload = evt.payload;
        this._handleIncomingCallOffer(payload);
      })
      .subscribe();

    // 2. Calls tablosu postgres_changes ile dinle (yedekleme kanalı)
    if (this.callDbSubscription) {
      this.supabase.removeChannel(this.callDbSubscription);
    }

    this.callDbSubscription = this.supabase
      .channel(`calls-db:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'calls',
          filter: `callee_id=eq.${user.id}`,
        },
        async (payload) => {
          const newCall = payload.new;
          if (newCall && newCall.status === 'ringing') {
            // Arayanın kullanıcı adını getir
            let callerName = 'Kullanıcı';
            try {
              const { data } = await this.supabase
                .from('users')
                .select('username, display_name')
                .eq('id', newCall.caller_id)
                .single();
              if (data) callerName = data.display_name || data.username || 'Kullanıcı';
            } catch (e) {}

            this._handleIncomingCallOffer({
              callId: newCall.id,
              callerId: newCall.caller_id,
              callerName: callerName,
              callType: newCall.type || 'audio',
            });
          }
        }
      )
      .subscribe();
  }

  _handleIncomingCallOffer(data) {
    if (this.connectionState !== 'idle') {
      // Meşgul ise aramayı reddet
      return;
    }

    this.activeCallId = data.callId;
    this.activeCallType = data.callType || 'audio';
    this.activeCallTarget = data.callerId;
    this.activeCallerName = data.callerName || 'Kullanıcı';
    this.isInitiator = false;
    this.connectionState = 'ringing';

    // Zil sesini çal
    if (window.voynSound) {
      window.voynSound.startRingtone();
    }

    // UI'da gelen arama modalını göster
    this._showIncomingCallModal(data);

    if (typeof this.onIncomingCall === 'function') {
      this.onIncomingCall(data);
    }
  }

  async _joinCallRoom(callId) {
    if (this.callRoomChannel) {
      await this.supabase.removeChannel(this.callRoomChannel);
    }

    this.callRoomChannel = this.supabase.channel(`call_room:${callId}`);

    this.callRoomChannel
      .on('broadcast', { event: 'callee_ready' }, async () => {
        // Karşı taraf açtı, arayan olarak Offer oluşturup gönderiyoruz
        if (this.isInitiator) {
          await this._createOffer();
        }
      })
      .on('broadcast', { event: 'sdp_offer' }, async (evt) => {
        if (!this.isInitiator) {
          await this._handleRemoteOffer(evt.payload.sdp);
        }
      })
      .on('broadcast', { event: 'sdp_answer' }, async (evt) => {
        if (this.isInitiator) {
          await this._handleRemoteAnswer(evt.payload.sdp);
        }
      })
      .on('broadcast', { event: 'ice_candidate' }, async (evt) => {
        await this._handleRemoteCandidate(evt.payload.candidate);
      })
      .on('broadcast', { event: 'call_ended' }, async () => {
        await this._cleanupCall('remote_ended');
      })
      .on('broadcast', { event: 'call_rejected' }, async () => {
        await this._cleanupCall('rejected');
      })
      .subscribe();
  }

  /* ─────────────────────────── PEER CONNECTION ─────────────────────────── */

  async _createPeerConnection() {
    if (this.peerConnection) return;

    this.peerConnection = new RTCPeerConnection(this.iceConfig);

    // 1. Yerel parçaları ekle
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // 2. Uzak medya dinleyicisi
    this.peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Uzak medya track alındı:', event.track.kind);
      this.remoteStream = event.streams[0] || new MediaStream([event.track]);

      const remoteAudio = document.getElementById('remote-audio');
      if (remoteAudio) {
        remoteAudio.srcObject = this.remoteStream;
        remoteAudio.play().catch((e) => console.warn('Audio play hatası:', e));
      }

      if (this.activeCallType === 'video') {
        const remoteVideo = document.getElementById('remote-video');
        if (remoteVideo) {
          remoteVideo.srcObject = this.remoteStream;
          remoteVideo.play().catch((e) => console.warn('Video play hatası:', e));
        }
      }
    };

    // 3. ICE Candidate
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.callRoomChannel) {
        this.callRoomChannel.send({
          type: 'broadcast',
          event: 'ice_candidate',
          payload: { candidate: event.candidate.toJSON() },
        });
      }
    };

    // 4. Bağlantı durumu
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      console.log('[WebRTC] Bağlantı durumu:', state);

      if (state === 'connected') {
        if (window.voynSound) {
          window.voynSound.stopOutgoingTone();
          window.voynSound.stopRingtone();
        }
        this.connectionState = 'connected';
        this._updateCallScreenUI('connected', this.activeCallerName, this.activeCallType);
        if (typeof this.onCallConnected === 'function') this.onCallConnected();
      } else if (state === 'disconnected' || state === 'failed') {
        this._cleanupCall(state);
      }
    };
  }

  async _createOffer() {
    try {
      await this._createPeerConnection();

      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.activeCallType === 'video',
      });

      await this.peerConnection.setLocalDescription(offer);

      if (this.callRoomChannel) {
        this.callRoomChannel.send({
          type: 'broadcast',
          event: 'sdp_offer',
          payload: { sdp: offer },
        });
      }
    } catch (err) {
      console.error('[WebRTC] _createOffer hatası:', err);
    }
  }

  async _handleRemoteOffer(sdp) {
    try {
      await this._createPeerConnection();
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));

      // Kuyruktaki ICE adaylarını ekle
      await this._flushPendingCandidates();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      if (this.callRoomChannel) {
        this.callRoomChannel.send({
          type: 'broadcast',
          event: 'sdp_answer',
          payload: { sdp: answer },
        });
      }
    } catch (err) {
      console.error('[WebRTC] _handleRemoteOffer hatası:', err);
    }
  }

  async _handleRemoteAnswer(sdp) {
    try {
      if (this.peerConnection) {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        await this._flushPendingCandidates();
      }
    } catch (err) {
      console.error('[WebRTC] _handleRemoteAnswer hatası:', err);
    }
  }

  async _handleRemoteCandidate(candidateData) {
    try {
      const candidate = new RTCIceCandidate(candidateData);
      if (this.peerConnection && this.peerConnection.remoteDescription) {
        await this.peerConnection.addIceCandidate(candidate);
      } else {
        this.pendingCandidates.push(candidate);
      }
    } catch (err) {
      console.warn('[WebRTC] ICE candidate eklenemedi:', err);
    }
  }

  async _flushPendingCandidates() {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    for (const c of this.pendingCandidates) {
      try {
        await this.peerConnection.addIceCandidate(c);
      } catch (e) {}
    }
    this.pendingCandidates = [];
  }

  /* ─────────────────────────── MEDIA & DEVICES ─────────────────────────── */

  async _getLocalMedia(type) {
    const isVideo = type === 'video';
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: isVideo
        ? {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: 'user',
          }
        : false,
    };

    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

    if (isVideo) {
      const localVideo = document.getElementById('local-video');
      if (localVideo) {
        localVideo.srcObject = this.localStream;
        localVideo.muted = true;
        localVideo.play().catch(() => {});
      }
    }
  }

  /* ─────────────────────────── UI & CLEANUP ───────────────────────────── */

  _showIncomingCallModal(data) {
    const modal = document.getElementById('modal-incoming-call');
    if (!modal) return;

    const nameEl = document.getElementById('incoming-call-name');
    const letterEl = document.getElementById('incoming-call-letter');
    const typeEl = document.getElementById('incoming-call-type');

    if (nameEl) nameEl.textContent = data.callerName || 'VOYN Kullanıcısı';
    if (letterEl) letterEl.textContent = (data.callerName || '?')[0].toUpperCase();
    if (typeEl) {
      typeEl.textContent = data.callType === 'video' ? '📹 Görüntülü Arama' : '📞 Sesli Arama';
    }

    modal.classList.add('open');
  }

  _hideIncomingCallModal() {
    const modal = document.getElementById('modal-incoming-call');
    if (modal) modal.classList.remove('open');
  }

  _updateCallScreenUI(state, callerName, type) {
    if (window.voynApp && typeof window.voynApp.showScreen === 'function') {
      window.voynApp.showScreen('call');
    }

    const nameEl = document.getElementById('call-name');
    const letterEl = document.getElementById('call-avatar-letter');
    const statusEl = document.getElementById('call-status');
    const videoArea = document.getElementById('call-video-area');

    if (nameEl) nameEl.textContent = callerName || 'Arama';
    if (letterEl) letterEl.textContent = (callerName || '?')[0].toUpperCase();

    if (statusEl) {
      if (state === 'calling') statusEl.textContent = 'Aranıyor…';
      else if (state === 'connected') statusEl.textContent = 'Bağlandı';
      else statusEl.textContent = 'Bağlanıyor…';
    }

    if (videoArea) {
      videoArea.style.display = type === 'video' ? 'flex' : 'none';
    }
  }

  _startCallTimeout(ms = 45000) {
    if (this._callTimeoutTimer) clearTimeout(this._callTimeoutTimer);
    this._callTimeoutTimer = setTimeout(async () => {
      if (this.connectionState === 'calling') {
        console.log('[WebRTC] Arama zaman aşımına uğradı');
        await this.endCall();
        if (window.voynApp && typeof window.voynApp._showToast === 'function') {
          window.voynApp._showToast('Cevap verilmedi', 'info');
        }
      }
    }, ms);
  }

  async _cleanupCall(reason = 'ended') {
    if (this._callTimeoutTimer) {
      clearTimeout(this._callTimeoutTimer);
      this._callTimeoutTimer = null;
    }

    if (window.voynSound) {
      window.voynSound.stopOutgoingTone();
      window.voynSound.stopRingtone();
    }

    this._hideIncomingCallModal();

    // Medyayı kapat
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Video/Audio elementlerini temizle
    ['local-video', 'remote-video', 'remote-audio'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.srcObject = null;
    });

    if (this.callRoomChannel) {
      await this.supabase.removeChannel(this.callRoomChannel);
      this.callRoomChannel = null;
    }

    this.activeCallId = null;
    this.activeCallType = 'audio';
    this.activeCallTarget = null;
    this.activeCallerName = null;
    this.isInitiator = false;
    this.isMuted = false;
    this.isVideoOff = false;
    this.pendingCandidates = [];
    this.connectionState = 'idle';

    if (typeof this.onCallEnded === 'function') {
      this.onCallEnded(reason);
    }

    // Görüşme bitince önceki ekrana dön
    if (window.voynApp && typeof window.voynApp.showScreen === 'function') {
      if (window.voynApp._activeConversationId) {
        window.voynApp.showScreen('chat');
      } else {
        window.voynApp.showScreen('home');
      }
    }
  }

  _handleError(ctx, err) {
    if (typeof this.onError === 'function') {
      this.onError({ context: ctx, error: err });
    }
  }

  destroy() {
    if (this.userSignalChannel) {
      this.supabase.removeChannel(this.userSignalChannel);
      this.userSignalChannel = null;
    }
    if (this.callDbSubscription) {
      this.supabase.removeChannel(this.callDbSubscription);
      this.callDbSubscription = null;
    }
    this._cleanupCall('destroy');
  }
}

// Global export
if (typeof window !== 'undefined') {
  window.VoynWebRTC = VoynWebRTC;
}
