/**
 * VOYN WebRTC - Sesli/Görüntülü Arama Sistemi
 * Supabase Realtime üzerinden signaling
 */

class VoynWebRTC {
  constructor(supabaseClient, currentUser) {
    this.supabase = supabaseClient;
    this.currentUser = currentUser;

    // RTCPeerConnection instance
    this.peerConnection = null;

    // MediaStream referansları
    this.localStream = null;
    this.remoteStream = null;

    // Aktif arama bilgileri
    this.activeCallId = null;
    this.activeCallType = null; // 'audio' | 'video'
    this.activeCallTarget = null;
    this.isInitiator = false;

    // ICE candidate kuyruğu (remote description gelmeden önce gelenler)
    this.pendingCandidates = [];

    // Realtime subscription
    this.callSubscription = null;

    // Durum
    this.isMuted = false;
    this.isVideoOff = false;
    this.connectionState = 'idle'; // idle | calling | ringing | connected | ended

    // ICE yapılandırması
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

    // Event callbacks
    this.onIncomingCall = null;      // (callData) => void
    this.onCallConnected = null;     // () => void
    this.onCallEnded = null;         // (reason) => void
    this.onRemoteStream = null;      // (stream) => void
    this.onConnectionStateChange = null; // (state) => void
    this.onError = null;             // (error) => void

    // Supabase Realtime kanal dinlemeyi başlat
    this._listenForSignals();
  }

  /* ─────────────────────────── PUBLIC API ─────────────────────────── */

  /**
   * Arama başlat
   * @param {string} targetUserId - Aranacak kullanıcının ID'si
   * @param {'audio'|'video'} type - Arama tipi
   */
  async startCall(targetUserId, type = 'audio') {
    try {
      if (this.connectionState !== 'idle') {
        throw new Error('Zaten aktif bir arama var');
      }

      this.isInitiator = true;
      this.activeCallType = type;
      this.activeCallTarget = targetUserId;
      this.connectionState = 'calling';

      // Medya akışını al
      await this._getLocalMedia(type);

      // Arama kaydı oluştur
      const callId = this._generateCallId();
      this.activeCallId = callId;

      await this.supabase.from('calls').insert({
        id: callId,
        caller_id: this.currentUser.id,
        callee_id: targetUserId,
        type: type,
        status: 'ringing',
        created_at: new Date().toISOString(),
      });

      // RTCPeerConnection kur
      await this._createPeerConnection();

      // Offer oluştur
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: type === 'video',
      });

      await this.peerConnection.setLocalDescription(offer);

      // Offer'ı karşı tarafa gönder
      await this._sendSignal(callId, {
        type: 'offer',
        sdp: offer,
        callType: type,
        callerName: this.currentUser.username || this.currentUser.id,
      });

      this._updateUI('calling');
      this._startCallTimeout();

    } catch (err) {
      this._handleError('startCall', err);
      await this._cleanupCall('error');
    }
  }

  /**
   * Gelen aramayı cevapla
   * @param {string} callId
   */
  async answerCall(callId) {
    try {
      this.activeCallId = callId;
      this.isInitiator = false;
      this.connectionState = 'connected';

      // Medya akışını al
      await this._getLocalMedia(this.activeCallType);

      // RTCPeerConnection kur (zaten kurulduysa geç)
      if (!this.peerConnection) {
        await this._createPeerConnection();
      }

      // Çağrı durumunu güncelle
      await this.supabase
        .from('calls')
        .update({ status: 'active', answered_at: new Date().toISOString() })
        .eq('id', callId);

      // Answer oluştur
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      // Answer'ı gönder
      await this._sendSignal(callId, {
        type: 'answer',
        sdp: answer,
      });

      // Bekleyen ICE candidate'leri ekle
      await this._flushPendingCandidates();

      this._updateUI('connected');

    } catch (err) {
      this._handleError('answerCall', err);
      await this._cleanupCall('error');
    }
  }

  /**
   * Gelen aramayı reddet
   * @param {string} callId
   */
  async rejectCall(callId) {
    try {
      await this.supabase
        .from('calls')
        .update({ status: 'rejected', ended_at: new Date().toISOString() })
        .eq('id', callId);

      await this._sendSignal(callId, { type: 'reject' });
      await this._cleanupCall('rejected');

    } catch (err) {
      this._handleError('rejectCall', err);
    }
  }

  /**
   * Aktif aramayı bitir
   */
  async endCall() {
    if (!this.activeCallId) return;

    try {
      await this.supabase
        .from('calls')
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', this.activeCallId);

      await this._sendSignal(this.activeCallId, { type: 'hangup' });
      await this._cleanupCall('ended');

    } catch (err) {
      this._handleError('endCall', err);
      await this._cleanupCall('error');
    }
  }

  /**
   * Mikrofonu aç/kapat
   * @returns {boolean} Yeni mute durumu
   */
  toggleMute() {
    if (!this.localStream) return this.isMuted;

    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMuted;
    });

    this._updateMuteUI();
    return this.isMuted;
  }

  /**
   * Kamerayı aç/kapat
   * @returns {boolean} Yeni video durumu
   */
  toggleVideo() {
    if (!this.localStream) return this.isVideoOff;

    this.isVideoOff = !this.isVideoOff;
    this.localStream.getVideoTracks().forEach(track => {
      track.enabled = !this.isVideoOff;
    });

    this._updateVideoUI();
    return this.isVideoOff;
  }

  /**
   * Hoparlör/telefon çıkışını değiştir (mobil)
   */
  async toggleSpeaker() {
    if (!this.remoteStream) return;
    // AudioContext üzerinden routing (mobil cihazlarda)
    try {
      const audioEl = document.getElementById('remote-audio');
      if (audioEl && audioEl.setSinkId) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const speaker = devices.find(d => d.kind === 'audiooutput' && d.label.toLowerCase().includes('speaker'));
        if (speaker) {
          await audioEl.setSinkId(speaker.deviceId);
        }
      }
    } catch (err) {
      console.warn('Speaker toggle desteklenmiyor:', err);
    }
  }

  /**
   * Ekran paylaşımını başlat/durdur
   */
  async toggleScreenShare() {
    try {
      if (this._screenShareStream) {
        // Ekran paylaşımını durdur, kameraya dön
        this._screenShareStream.getTracks().forEach(t => t.stop());
        this._screenShareStream = null;

        // Kamera track'ini geri yükle
        const camTrack = this.localStream.getVideoTracks()[0];
        if (camTrack && this.peerConnection) {
          const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(camTrack);
        }
      } else {
        // Ekran paylaşımını başlat
        this._screenShareStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always' },
          audio: false,
        });

        const screenTrack = this._screenShareStream.getVideoTracks()[0];
        if (screenTrack && this.peerConnection) {
          const sender = this.peerConnection.getSenders().find(s => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(screenTrack);
        }

        // Ekran paylaşımı durdurulduğunda
        screenTrack.addEventListener('ended', () => {
          this.toggleScreenShare();
        });
      }
    } catch (err) {
      this._handleError('toggleScreenShare', err);
    }
  }

  /* ─────────────────────────── PRIVATE: SIGNALING ─────────────────────── */

  /**
   * Supabase Realtime üzerinden gelen sinyal mesajlarını dinle
   */
  _listenForSignals() {
    this.callSubscription = this.supabase
      .channel(`calls:${this.currentUser.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'call_signals',
          filter: `to_user=eq.${this.currentUser.id}`,
        },
        (payload) => this._handleSignal(payload.new)
      )
      .subscribe();
  }

  /**
   * Sinyal mesajı gönder
   */
  async _sendSignal(callId, data) {
    await this.supabase.from('call_signals').insert({
      call_id: callId,
      from_user: this.currentUser.id,
      to_user: this.isInitiator ? this.activeCallTarget : (await this._getCallerId(callId)),
      signal_type: data.type,
      payload: JSON.stringify(data),
      created_at: new Date().toISOString(),
    });
  }

  /**
   * Gelen sinyal mesajını işle
   */
  async _handleSignal(signal) {
    try {
      const data = JSON.parse(signal.payload);

      switch (data.type) {
        case 'offer':
          await this._handleOffer(signal, data);
          break;
        case 'answer':
          await this._handleAnswer(data);
          break;
        case 'ice-candidate':
          await this._handleIceCandidate(data);
          break;
        case 'reject':
          await this._cleanupCall('rejected');
          break;
        case 'hangup':
          await this._cleanupCall('remote-hangup');
          break;
        default:
          console.warn('Bilinmeyen sinyal tipi:', data.type);
      }
    } catch (err) {
      this._handleError('_handleSignal', err);
    }
  }

  async _handleOffer(signal, data) {
    // Gelen arama bildirimi göster
    this.activeCallId = signal.call_id;
    this.activeCallType = data.callType || 'audio';
    this.activeCallTarget = signal.from_user;
    this.isInitiator = false;
    this.connectionState = 'ringing';

    // RTCPeerConnection kur
    await this._createPeerConnection();

    // Remote description ayarla
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

    // Bekleyen ICE candidate'leri uygula
    await this._flushPendingCandidates();

    // UI callback
    if (typeof this.onIncomingCall === 'function') {
      this.onIncomingCall({
        callId: signal.call_id,
        callerId: signal.from_user,
        callerName: data.callerName || signal.from_user,
        callType: data.callType || 'audio',
      });
    }

    this._updateUI('ringing');
  }

  async _handleAnswer(data) {
    if (!this.peerConnection) return;
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await this._flushPendingCandidates();
    this.connectionState = 'connected';
    this._updateUI('connected');
    if (typeof this.onCallConnected === 'function') this.onCallConnected();
  }

  async _handleIceCandidate(data) {
    const candidate = new RTCIceCandidate(data.candidate);

    if (this.peerConnection && this.peerConnection.remoteDescription) {
      await this.peerConnection.addIceCandidate(candidate);
    } else {
      // Remote description henüz gelmedi, kuyruğa al
      this.pendingCandidates.push(candidate);
    }
  }

  async _flushPendingCandidates() {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    for (const candidate of this.pendingCandidates) {
      try {
        await this.peerConnection.addIceCandidate(candidate);
      } catch (err) {
        console.warn('ICE candidate eklenemedi:', err);
      }
    }
    this.pendingCandidates = [];
  }

  /* ─────────────────────────── PRIVATE: PEER CONNECTION ──────────────── */

  async _createPeerConnection() {
    this.peerConnection = new RTCPeerConnection(this.iceConfig);

    // Local stream track'lerini ekle
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // Remote stream oluştur
    this.remoteStream = new MediaStream();
    const remoteAudio = document.getElementById('remote-audio');
    const remoteVideo = document.getElementById('remote-video');
    if (remoteAudio) remoteAudio.srcObject = this.remoteStream;
    if (remoteVideo) remoteVideo.srcObject = this.remoteStream;

    // Track olayları
    this.peerConnection.ontrack = (event) => {
      event.streams[0].getTracks().forEach(track => {
        this.remoteStream.addTrack(track);
      });
      if (typeof this.onRemoteStream === 'function') {
        this.onRemoteStream(this.remoteStream);
      }
    };

    // ICE candidate olayı
    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate && this.activeCallId) {
        await this._sendSignal(this.activeCallId, {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Bağlantı durumu değişimi
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      console.log('[WebRTC] Connection state:', state);

      if (typeof this.onConnectionStateChange === 'function') {
        this.onConnectionStateChange(state);
      }

      if (state === 'connected') {
        this.connectionState = 'connected';
        this._updateUI('connected');
        if (typeof this.onCallConnected === 'function') this.onCallConnected();
      } else if (state === 'failed' || state === 'disconnected') {
        this._cleanupCall(state);
      }
    };

    // ICE bağlantı durumu
    this.peerConnection.oniceconnectionstatechange = () => {
      const iceState = this.peerConnection.iceConnectionState;
      console.log('[WebRTC] ICE state:', iceState);

      if (iceState === 'failed') {
        // ICE restart dene
        this._restartIce();
      }
    };

    // Negotiation needed
    this.peerConnection.onnegotiationneeded = async () => {
      if (this.isInitiator && this.connectionState === 'connected') {
        try {
          const offer = await this.peerConnection.createOffer();
          await this.peerConnection.setLocalDescription(offer);
          await this._sendSignal(this.activeCallId, { type: 'offer', sdp: offer });
        } catch (err) {
          console.warn('Renegotiation hatası:', err);
        }
      }
    };
  }

  async _restartIce() {
    if (!this.isInitiator || !this.peerConnection) return;
    try {
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      await this._sendSignal(this.activeCallId, { type: 'offer', sdp: offer });
    } catch (err) {
      console.warn('ICE restart hatası:', err);
    }
  }

  /* ─────────────────────────── PRIVATE: MEDIA ─────────────────────────── */

  async _getLocalMedia(type) {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: type === 'video' ? {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        facingMode: 'user',
      } : false,
    };

    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Yerel video önizleme
    const localVideo = document.getElementById('local-video');
    if (localVideo && type === 'video') {
      localVideo.srcObject = this.localStream;
      localVideo.muted = true; // Kendi sesini duymamak için
    }
  }

  /* ─────────────────────────── PRIVATE: CLEANUP ───────────────────────── */

  async _cleanupCall(reason = 'ended') {
    // Call timeout temizle
    if (this._callTimeoutId) {
      clearTimeout(this._callTimeoutId);
      this._callTimeoutId = null;
    }

    // MediaStream'leri durdur
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    if (this._screenShareStream) {
      this._screenShareStream.getTracks().forEach(t => t.stop());
      this._screenShareStream = null;
    }

    // PeerConnection'ı kapat
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Video elementlerini temizle
    ['local-video', 'remote-video', 'remote-audio'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.srcObject = null;
    });

    // Durumu sıfırla
    const previousCallId = this.activeCallId;
    this.activeCallId = null;
    this.activeCallType = null;
    this.activeCallTarget = null;
    this.isInitiator = false;
    this.isMuted = false;
    this.isVideoOff = false;
    this.pendingCandidates = [];
    this.connectionState = 'idle';
    this.remoteStream = null;

    // UI callback
    if (typeof this.onCallEnded === 'function') {
      this.onCallEnded(reason);
    }

    this._updateUI('idle');
    console.log('[WebRTC] Arama sona erdi:', reason, 'callId:', previousCallId);
  }

  /* ─────────────────────────── PRIVATE: HELPERS ───────────────────────── */

  _generateCallId() {
    return `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  async _getCallerId(callId) {
    const { data } = await this.supabase
      .from('calls')
      .select('caller_id')
      .eq('id', callId)
      .single();
    return data?.caller_id;
  }

  _startCallTimeout(ms = 45000) {
    this._callTimeoutId = setTimeout(async () => {
      if (this.connectionState === 'calling') {
        await this._cleanupCall('timeout');
        await this.supabase
          .from('calls')
          .update({ status: 'missed' })
          .eq('id', this.activeCallId);
      }
    }, ms);
  }

  _updateUI(state) {
    const callScreen = document.getElementById('screen-call');
    if (!callScreen) return;

    // Mevcut sınıfları temizle
    callScreen.classList.remove('state-idle', 'state-calling', 'state-ringing', 'state-connected');
    callScreen.classList.add(`state-${state}`);

    // Ekranı göster/gizle
    if (state === 'idle') {
      callScreen.classList.add('hidden');
    } else {
      callScreen.classList.remove('hidden');
    }

    // Durum metni
    const statusEl = document.getElementById('call-status');
    const statusMap = {
      calling: 'Aranıyor...',
      ringing: 'Gelen Arama',
      connected: 'Bağlandı',
      idle: '',
    };
    if (statusEl) statusEl.textContent = statusMap[state] || '';
  }

  _updateMuteUI() {
    const muteBtn = document.getElementById('call-mute-btn');
    if (muteBtn) {
      muteBtn.classList.toggle('active', this.isMuted);
      muteBtn.setAttribute('aria-pressed', this.isMuted);
      muteBtn.title = this.isMuted ? 'Mikrofonu Aç' : 'Mikrofonu Kapat';
    }
  }

  _updateVideoUI() {
    const videoBtn = document.getElementById('call-video-btn');
    if (videoBtn) {
      videoBtn.classList.toggle('active', this.isVideoOff);
      videoBtn.setAttribute('aria-pressed', this.isVideoOff);
      videoBtn.title = this.isVideoOff ? 'Kamerayı Aç' : 'Kamerayı Kapat';
    }
  }

  _handleError(context, err) {
    console.error(`[WebRTC] ${context}:`, err);
    if (typeof this.onError === 'function') {
      this.onError({ context, message: err.message, error: err });
    }
  }

  /**
   * Realtime aboneliğini temizle (uygulama kapanırken)
   */
  destroy() {
    if (this.callSubscription) {
      this.supabase.removeChannel(this.callSubscription);
      this.callSubscription = null;
    }
    this._cleanupCall('destroy');
  }
}

// Global export
if (typeof window !== 'undefined') {
  window.VoynWebRTC = VoynWebRTC;
}
