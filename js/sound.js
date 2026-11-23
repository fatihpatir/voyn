/**
 * VOYN Sound - Web Audio API Tabanlı Ses ve Melodi Sentezleyici
 * Dış ses dosyası gerektirmez, %100 saf AudioContext ile çalışır.
 */

class VoynSound {
  constructor() {
    this.ctx = null;
    this._ringtoneTimer = null;
    this._outgoingTimer = null;
    this._isUnlocked = false;

    // Kullanıcı ilk dokunduğunda veya tıkladığında ses motorunu uyandır
    const unlock = () => {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      this._isUnlocked = true;
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
    };

    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('touchstart', unlock, { once: true });
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /**
   * Yeni mesaj bildirim sesi (Zarif 2 tonlu cam tınısı)
   */
  playMessageSound() {
    try {
      this.init();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;

      // 1. Ton (587.33 Hz - D5)
      const osc1 = this.ctx.createOscillator();
      const gain1 = this.ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0, now);
      gain1.gain.linearRampToValueAtTime(0.25, now + 0.02);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc1.connect(gain1);
      gain1.connect(this.ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.25);

      // 2. Ton (880.00 Hz - A5)
      const osc2 = this.ctx.createOscillator();
      const gain2 = this.ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.08);
      gain2.gain.setValueAtTime(0, now + 0.08);
      gain2.gain.linearRampToValueAtTime(0.35, now + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      osc2.connect(gain2);
      gain2.connect(this.ctx.destination);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.55);

      // Titreşim
      if (navigator.vibrate) {
        navigator.vibrate([70, 40, 70]);
      }
    } catch (e) {
      console.warn('[VoynSound] Mesaj sesi hatası:', e);
    }
  }

  /**
   * Mesaj gönderildi sesi (Hafif 'pop' efekti)
   */
  playSentSound() {
    try {
      this.init();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(700, now + 0.08);

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } catch (e) {
      console.warn('[VoynSound] Gönderildi sesi hatası:', e);
    }
  }

  /**
   * Gelen arama zil sesi (Tekrarlayan melodik çan tınısı)
   */
  startRingtone() {
    this.stopRingtone();
    this.init();

    const playChimeSequence = () => {
      try {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6

        notes.forEach((freq, idx) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          const start = now + idx * 0.18;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, start);

          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);

          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(start);
          osc.stop(start + 0.45);
        });

        // Titreşim
        if (navigator.vibrate) {
          navigator.vibrate([400, 200, 400, 200]);
        }
      } catch (e) {
        console.warn('[VoynSound] Ringtone çalma hatası:', e);
      }
    };

    playChimeSequence();
    this._ringtoneTimer = setInterval(playChimeSequence, 2400);
  }

  stopRingtone() {
    if (this._ringtoneTimer) {
      clearInterval(this._ringtoneTimer);
      this._ringtoneTimer = null;
    }
    if (navigator.vibrate) {
      navigator.vibrate(0);
    }
  }

  /**
   * Giden arama sinyal sesi (Bip... Bip... bekleme tonu)
   */
  startOutgoingTone() {
    this.stopOutgoingTone();
    this.init();

    const playTone = () => {
      try {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(425, now);

        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
        gain.gain.setValueAtTime(0.15, now + 0.95);
        gain.gain.linearRampToValueAtTime(0.001, now + 1.0);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 1.0);
      } catch (e) {
        console.warn('[VoynSound] Outgoing tone hatası:', e);
      }
    };

    playTone();
    this._outgoingTimer = setInterval(playTone, 3200);
  }

  stopOutgoingTone() {
    if (this._outgoingTimer) {
      clearInterval(this._outgoingTimer);
      this._outgoingTimer = null;
    }
  }
}

// Global instance
window.voynSound = new VoynSound();
