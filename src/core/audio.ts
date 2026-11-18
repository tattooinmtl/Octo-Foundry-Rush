/**
 * Fully synthesised audio - no sample files, so the game ships with zero audio
 * payload and starts instantly. Every tower kind gets its own voice.
 */

type Ctx = AudioContext;

export class AudioEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastAt: Record<string, number> = {};

  masterVolume = 0.8;
  sfxVolume = 0.9;
  muted = false;

  /** Must be called from a user gesture (menu tap). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext =
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? window.AudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterVolume;
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;

    this.sfxBus.connect(this.master);
    this.master.connect(comp);
    comp.connect(ctx.destination);

    const len = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setMaster(v: number): void {
    this.masterVolume = v;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.02);
    }
  }

  setSfx(v: number): void {
    this.sfxVolume = v;
    if (this.sfxBus && this.ctx) {
      this.sfxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : this.masterVolume, this.ctx.currentTime, 0.02);
    }
  }

  /** Rate limit so 30 towers firing do not turn into noise. */
  private throttled(key: string, minGap: number): boolean {
    if (!this.ctx) return true;
    const now = this.ctx.currentTime;
    const last = this.lastAt[key] ?? -99;
    if (now - last < minGap) return true;
    this.lastAt[key] = now;
    return false;
  }

  private tone(
    type: OscillatorType,
    freq: number,
    dur: number,
    gain: number,
    opts: { freqTo?: number; delay?: number; attack?: number; detune?: number } = {},
  ): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.freqTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqTo), t0 + dur);
    }
    if (opts.detune) osc.detune.value = opts.detune;
    const g = ctx.createGain();
    const attack = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  private noiseBurst(
    dur: number,
    gain: number,
    filter: { type: BiquadFilterType; freq: number; freqTo?: number; q?: number },
    delay = 0,
  ): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || !this.noise) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bq = ctx.createBiquadFilter();
    bq.type = filter.type;
    bq.frequency.setValueAtTime(filter.freq, t0);
    if (filter.freqTo !== undefined) {
      bq.frequency.exponentialRampToValueAtTime(Math.max(40, filter.freqTo), t0 + dur);
    }
    bq.Q.value = filter.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bq);
    bq.connect(g);
    g.connect(bus);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /** Per-tower fire voice, keyed by the tower's projectile shape. */
  fire(shape: string): void {
    if (!this.ready) return;
    if (this.throttled('fire:' + shape, 0.035)) return;
    switch (shape) {
      case 'shell':
      case 'cannon':
        this.tone('sine', 120, 0.16, 0.35, { freqTo: 44 });
        this.noiseBurst(0.1, 0.16, { type: 'bandpass', freq: 900, freqTo: 300, q: 1.2 });
        break;
      case 'bolt':
      case 'coil':
      case 'chainmail':
        this.tone('sawtooth', 1400, 0.1, 0.12, { freqTo: 2600 });
        this.noiseBurst(0.08, 0.1, { type: 'highpass', freq: 2200 });
        break;
      case 'shard':
      case 'crystal':
      case 'fang':
      case 'needle':
        this.tone('triangle', 900, 0.13, 0.16, { freqTo: 1500 });
        break;
      case 'spore':
      case 'bio':
        this.tone('sine', 320, 0.22, 0.14, { freqTo: 150 });
        this.noiseBurst(0.16, 0.08, { type: 'lowpass', freq: 700 });
        break;
      case 'plume':
      case 'ember':
      case 'torrent':
        this.noiseBurst(0.18, 0.09, { type: 'lowpass', freq: 1500, freqTo: 500 });
        break;
      case 'pellet':
        this.tone('square', 620, 0.05, 0.1, { freqTo: 380 });
        break;
      case 'lance':
        this.tone('sawtooth', 180, 0.3, 0.12, { freqTo: 1500 });
        this.tone('square', 2400, 0.12, 0.07, { freqTo: 600, delay: 0.16 });
        break;
      case 'orb':
      case 'plasma':
      case 'vortex':
      case 'pulse':
        this.tone('sine', 520, 0.2, 0.16, { freqTo: 980 });
        this.tone('sine', 780, 0.24, 0.08, { freqTo: 1500, delay: 0.02 });
        break;
      case 'disc':
      case 'wave':
      case 'helix':
      case 'prism':
        this.tone('triangle', 700, 0.14, 0.14, { freqTo: 1100 });
        break;
      case 'mine':
      case 'drone':
        this.tone('square', 300, 0.18, 0.09, { freqTo: 460 });
        break;
      case 'lattice':
        this.tone('square', 1100, 0.09, 0.08, { freqTo: 1600 });
        break;
      case 'snare':
        this.tone('sine', 240, 0.3, 0.16, { freqTo: 90 });
        break;
      default:
        this.tone('square', 480, 0.08, 0.11, { freqTo: 260 });
    }
  }

  impact(kind: string): void {
    if (!this.ready) return;
    if (this.throttled('impact', 0.045)) return;
    switch (kind) {
      case 'burn':
      case 'plume':
      case 'ember':
        this.noiseBurst(0.14, 0.09, { type: 'lowpass', freq: 1100, freqTo: 300 });
        break;
      case 'chill':
      case 'shard':
      case 'frost':
        this.tone('triangle', 1500, 0.18, 0.1, { freqTo: 2400 });
        this.noiseBurst(0.12, 0.05, { type: 'highpass', freq: 3200 });
        break;
      case 'chain':
      case 'electric':
      case 'bolt':
        this.noiseBurst(0.12, 0.11, { type: 'bandpass', freq: 2800, q: 4 });
        break;
      default:
        this.noiseBurst(0.1, 0.11, { type: 'lowpass', freq: 2400, freqTo: 600 });
    }
  }

  death(): void {
    if (!this.ready) return;
    if (this.throttled('death', 0.05)) return;
    this.tone('sine', 300, 0.24, 0.14, { freqTo: 70 });
    this.noiseBurst(0.2, 0.09, { type: 'lowpass', freq: 900, freqTo: 200 });
  }

  explosion(): void {
    if (!this.ready) return;
    this.tone('sine', 90, 0.5, 0.4, { freqTo: 28 });
    this.noiseBurst(0.45, 0.28, { type: 'lowpass', freq: 2400, freqTo: 160 });
  }

  gold(): void {
    if (!this.ready) return;
    if (this.throttled('gold', 0.07)) return;
    this.tone('sine', 1180, 0.07, 0.1);
    this.tone('sine', 1760, 0.09, 0.08, { delay: 0.05 });
  }

  ui(kind: 'click' | 'back' | 'error' = 'click'): void {
    if (!this.ready) return;
    if (kind === 'click') this.tone('square', 720, 0.045, 0.07);
    else if (kind === 'back') this.tone('square', 380, 0.06, 0.07);
    else this.tone('square', 180, 0.16, 0.09, { freqTo: 120 });
  }

  /** Construction-site klaxon: two-tone, slightly detuned, with a tremolo tail. */
  klaxon(): void {
    if (!this.ready) return;
    this.tone('sawtooth', 440, 0.34, 0.16);
    this.tone('sawtooth', 330, 0.34, 0.14, { delay: 0.34 });
    this.tone('sawtooth', 440, 0.42, 0.16, { delay: 0.68 });
    this.noiseBurst(0.9, 0.05, { type: 'bandpass', freq: 700, q: 2 });
  }

  waveClear(): void {
    if (!this.ready) return;
    this.tone('triangle', 523, 0.12, 0.11);
    this.tone('triangle', 659, 0.12, 0.11, { delay: 0.1 });
    this.tone('triangle', 784, 0.22, 0.12, { delay: 0.2 });
  }

  gameOver(): void {
    if (!this.ready) return;
    this.tone('sawtooth', 220, 0.5, 0.16, { freqTo: 70 });
    this.tone('sawtooth', 164, 0.7, 0.13, { freqTo: 55, delay: 0.18 });
    this.noiseBurst(0.9, 0.08, { type: 'lowpass', freq: 700, freqTo: 120 });
  }

  /** Rising gear whine while the forge is working. */
  forgeStart(): void {
    if (!this.ready) return;
    this.tone('sawtooth', 180, 1.4, 0.08, { freqTo: 1400 });
    this.noiseBurst(1.3, 0.04, { type: 'bandpass', freq: 600, freqTo: 3000, q: 3 });
  }

  forgeDone(): void {
    if (!this.ready) return;
    this.tone('square', 880, 0.08, 0.1);
    this.tone('square', 1320, 0.16, 0.1, { delay: 0.08 });
    this.tone('sine', 1760, 0.3, 0.09, { delay: 0.16 });
  }

  private hum: GainNode | null = null;
  private humOn = false;

  /**
   * Continuous high-voltage buzz for the electric portals: 60 Hz mains growl,
   * a detuned 120 Hz harmonic with a nervous wobble, and a hissing crackle bed.
   * Idempotent - safe to call every frame.
   */
  setPortalHum(on: boolean): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || !this.noise) return;
    if (on === this.humOn && (this.hum || !on)) return;
    this.humOn = on;
    if (!this.hum) {
      const out = ctx.createGain();
      out.gain.value = 0;
      out.connect(bus);

      // Buzz: saw + square through a lowpass, amplitude wobbled by an LFO.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1600;
      lp.Q.value = 2.5;
      const buzzAmp = ctx.createGain();
      buzzAmp.gain.value = 0.6;
      lp.connect(buzzAmp);
      buzzAmp.connect(out);

      const o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 60;
      const g1 = ctx.createGain();
      g1.gain.value = 0.55;
      o1.connect(g1);
      g1.connect(lp);

      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = 120;
      o2.detune.value = 9;
      const g2 = ctx.createGain();
      g2.gain.value = 0.2;
      o2.connect(g2);
      g2.connect(lp);

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 7.3;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 0.3;
      lfo.connect(lfoG);
      lfoG.connect(buzzAmp.gain);

      // Filter sweep wobble so the buzz "breathes".
      const lfo2 = ctx.createOscillator();
      lfo2.frequency.value = 0.9;
      const lfo2G = ctx.createGain();
      lfo2G.gain.value = 500;
      lfo2.connect(lfo2G);
      lfo2G.connect(lp.frequency);

      // Crackle bed: looping hiss, chopped by a fast square LFO.
      const hiss = ctx.createBufferSource();
      hiss.buffer = this.noise;
      hiss.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3200;
      const hissAmp = ctx.createGain();
      hissAmp.gain.value = 0.07;
      const chop = ctx.createOscillator();
      chop.type = 'square';
      chop.frequency.value = 17;
      const chopG = ctx.createGain();
      chopG.gain.value = 0.06;
      chop.connect(chopG);
      chopG.connect(hissAmp.gain);
      hiss.connect(hp);
      hp.connect(hissAmp);
      hissAmp.connect(out);

      for (const o of [o1, o2, lfo, lfo2, chop]) o.start();
      hiss.start();
      this.hum = out;
    }
    this.hum.gain.setTargetAtTime(on ? 0.09 : 0, ctx.currentTime, on ? 0.25 : 0.08);
  }

  /** Single arc crack - a stray bolt hitting the ground. */
  zap(): void {
    if (!this.ready) return;
    if (this.throttled('zap', 0.05)) return;
    const f = 1800 + Math.random() * 2600;
    this.noiseBurst(0.04 + Math.random() * 0.06, 0.13, { type: 'highpass', freq: f, q: 0.8 });
    this.tone('square', 2400 + Math.random() * 1800, 0.045, 0.04, { freqTo: 300 });
    if (Math.random() < 0.6) {
      this.noiseBurst(0.03, 0.08, { type: 'bandpass', freq: 5200, q: 3 }, 0.02 + Math.random() * 0.04);
    }
  }

  /** A creep stepping out of the entry portal: electric discharge. */
  portalSpawn(): void {
    if (!this.ready) return;
    if (this.throttled('portalSpawn', 0.09)) return;
    this.tone('sawtooth', 75, 0.42, 0.15, { freqTo: 34 });
    this.noiseBurst(0.38, 0.16, { type: 'bandpass', freq: 3400, freqTo: 800, q: 1.4 });
    this.tone('square', 3200, 0.07, 0.05, { freqTo: 220 });
    for (const d of [0.05, 0.11, 0.19, 0.27]) {
      this.noiseBurst(0.035, 0.1, { type: 'highpass', freq: 2200 + Math.random() * 2500 }, d + Math.random() * 0.03);
    }
  }

  /** A creep reaching the exit portal and escaping: sucked-in arc implosion. */
  portalExit(): void {
    if (!this.ready) return;
    if (this.throttled('portalExit', 0.09)) return;
    this.noiseBurst(0.3, 0.12, { type: 'bandpass', freq: 700, freqTo: 5200, q: 2 });
    this.tone('sawtooth', 60, 0.36, 0.14, { freqTo: 180, delay: 0.02 });
    this.noiseBurst(0.12, 0.18, { type: 'highpass', freq: 2600 }, 0.28);
    this.tone('square', 2800, 0.06, 0.06, { freqTo: 250, delay: 0.28 });
  }

  /** Looping filtered noise for sustained sounds (beam roar, fire). */
  private sustain(
    dur: number,
    gain: number,
    filter: { type: BiquadFilterType; freq: number; freqTo?: number; q?: number },
    opts: { attack?: number; release?: number; delay?: number; wobble?: number } = {},
  ): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || !this.noise) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const bq = ctx.createBiquadFilter();
    bq.type = filter.type;
    bq.frequency.setValueAtTime(filter.freq, t0);
    if (filter.freqTo !== undefined) bq.frequency.exponentialRampToValueAtTime(Math.max(40, filter.freqTo), t0 + dur);
    bq.Q.value = filter.q ?? 1;
    const g = ctx.createGain();
    const attack = opts.attack ?? 0.05;
    const release = opts.release ?? 0.3;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.setValueAtTime(gain, t0 + Math.max(attack, dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (opts.wobble) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = opts.wobble;
      const lg = ctx.createGain();
      lg.gain.value = gain * 0.45;
      lfo.connect(lg);
      lg.connect(g.gain);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.05);
    }
    src.connect(bq);
    bq.connect(g);
    g.connect(bus);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /** Sustained oscillator with an envelope (beam hum). */
  private drone(type: OscillatorType, freq: number, dur: number, gain: number, opts: { freqTo?: number; vibrato?: number; delay?: number } = {}): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (opts.freqTo) o.frequency.exponentialRampToValueAtTime(opts.freqTo, t0 + dur);
    if (opts.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = opts.vibrato;
      const lg = ctx.createGain();
      lg.gain.value = freq * 0.04;
      lfo.connect(lg);
      lg.connect(o.frequency);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.05);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.08);
    g.gain.setValueAtTime(gain, t0 + dur - 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(bus);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** Weapon armed: a short targeting chirp. */
  arm(): void {
    if (!this.ready) return;
    this.tone('square', 1320, 0.06, 0.06);
    this.tone('square', 1980, 0.08, 0.05, { delay: 0.06 });
  }

  /** Orbital laser: charge-up whine, then a 3s roaring, warbling beam. */
  orbitalLaser(duration: number): void {
    if (!this.ready) return;
    this.tone('sawtooth', 300, 0.22, 0.09, { freqTo: 2400 });
    this.noiseBurst(0.25, 0.22, { type: 'lowpass', freq: 4000, freqTo: 300 }, 0.15);
    this.tone('sine', 70, 0.6, 0.35, { freqTo: 30, delay: 0.15 });
    this.drone('sawtooth', 55, duration, 0.12, { vibrato: 9, delay: 0.15 });
    this.drone('square', 110.5, duration, 0.05, { vibrato: 13, delay: 0.15 });
    this.drone('sine', 880, duration, 0.035, { freqTo: 620, vibrato: 6, delay: 0.15 });
    this.sustain(duration, 0.16, { type: 'bandpass', freq: 900, freqTo: 600, q: 0.8 }, { delay: 0.15, wobble: 17 });
    this.sustain(duration, 0.07, { type: 'highpass', freq: 4200, q: 0.7 }, { delay: 0.15, wobble: 23 });
    this.noiseBurst(0.5, 0.12, { type: 'lowpass', freq: 1800, freqTo: 120 }, 0.15 + duration);
  }

  /** Deep freeze: crystalline shatter cascade over a cold whoosh. */
  deepFreeze(): void {
    if (!this.ready) return;
    this.noiseBurst(0.55, 0.2, { type: 'highpass', freq: 1200, freqTo: 7000, q: 0.6 });
    this.tone('sine', 140, 0.5, 0.25, { freqTo: 45 });
    const notes = [2637, 3136, 3520, 2093, 3951, 2794, 4186];
    notes.forEach((f, i) => {
      this.tone('triangle', f, 0.35, 0.06, { delay: 0.03 + i * 0.045, freqTo: f * 0.98 });
      this.noiseBurst(0.04, 0.07, { type: 'bandpass', freq: 6000 + i * 400, q: 6 }, 0.03 + i * 0.045);
    });
    this.sustain(1.6, 0.05, { type: 'bandpass', freq: 3000, freqTo: 900, q: 2 }, { delay: 0.2, release: 1 });
  }

  /** Hellfire: falling meteor whistle, a huge impact, then a roaring fire. */
  hellfire(fall: number, burn: number): void {
    if (!this.ready) return;
    this.tone('sawtooth', 1800, fall, 0.05, { freqTo: 300 });
    this.sustain(fall, 0.12, { type: 'bandpass', freq: 600, freqTo: 2400, q: 1.5 }, { attack: fall * 0.8, release: 0.02 });
    // impact
    this.tone('sine', 85, 0.8, 0.45, { freqTo: 26, delay: fall });
    this.noiseBurst(0.6, 0.32, { type: 'lowpass', freq: 3000, freqTo: 140 }, fall);
    // fire roar + crackle
    this.sustain(burn, 0.2, { type: 'lowpass', freq: 700, freqTo: 400, q: 0.7 }, { delay: fall + 0.05, wobble: 5, release: 0.6 });
    this.sustain(burn, 0.06, { type: 'highpass', freq: 3000, q: 0.5 }, { delay: fall + 0.05, wobble: 19, release: 0.6 });
    for (let i = 0; i < 10; i++) {
      this.noiseBurst(0.03, 0.08, { type: 'highpass', freq: 2000 + Math.random() * 3000 }, fall + 0.1 + Math.random() * burn);
    }
  }
}

export const audio = new AudioEngine();
