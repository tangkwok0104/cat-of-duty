import { bus } from '../core/EventBus';

/** Slice audio: five sounds synthesized with raw WebAudio — original work,
 *  license-clean, zero downloads. Howler takes over when real CC0 files land
 *  in /assets (M-audio pass); this module keeps the same event wiring.
 *  The context resumes on the first pointer-lock click (autoplay policy). */
export class SoundBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  constructor() {
    bus.on('weapon:fired', ({ profile }) => this.shot(profile));
    bus.on('weapon:dry', () => this.click(1200, 0.04, 0.25));
    bus.on('weapon:reload-start', () => this.click(700, 0.05, 0.3));
    bus.on('weapon:reload-end', () => this.click(1000, 0.05, 0.35));
    bus.on('weapon:switched', () => this.click(880, 0.04, 0.25));
    bus.on('enemy:hit', ({ killed, part }) => {
      if (killed) this.kill();
      else this.hit(part === 'head');
    });
    bus.on('player:damaged', () => this.hurt());
    bus.on('player:died', () => this.death());
  }

  /** Call from a user gesture (pointer-lock click). */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    }
    void this.ctx.resume();
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Gunshot: white-noise crack through a falling lowpass + a thump.
   *  Per-gun flavour: shotgun = longer/deeper boom, sniper = sharper crack. */
  private shot(profile: 'rifle' | 'shotgun' | 'sniper'): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const t = this.now();

    const noiseLen = profile === 'shotgun' ? 0.16 : profile === 'sniper' ? 0.12 : 0.09;
    const lpStart = profile === 'shotgun' ? 2600 : profile === 'sniper' ? 7000 : 5200;
    const lpEnd = profile === 'shotgun' ? 220 : 500;
    const thumpF = profile === 'shotgun' ? 95 : profile === 'sniper' ? 180 : 150;
    const thumpVol = profile === 'rifle' ? 0.5 : 0.65;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(lpStart, t);
    lp.frequency.exponentialRampToValueAtTime(lpEnd, t + noiseLen);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + noiseLen);
    noise.connect(lp).connect(ng).connect(out);
    noise.start(t);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(thumpF, t);
    thump.frequency.exponentialRampToValueAtTime(48, t + 0.1);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(thumpVol, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    thump.connect(tg).connect(out);
    thump.start(t);
    thump.stop(t + 0.12);
  }

  /** Hitmarker tick — brighter for headshots. */
  private hit(head: boolean): void {
    this.click(head ? 2400 : 1800, 0.035, 0.5);
  }

  /** Kill: crisp two-note rising confirm. */
  private kill(): void {
    this.tone(880, 0.05, 0.45, 'square');
    setTimeout(() => this.tone(1320, 0.07, 0.45, 'square'), 45);
  }

  /** Player hurt: short low grunt. */
  private hurt(): void {
    this.tone(180, 0.09, 0.5, 'sawtooth', 120);
  }

  /** Death: long falling drone. */
  private death(): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const t = this.now();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 1.05);
  }

  private click(freq: number, dur: number, vol: number): void {
    this.tone(freq, dur, vol, 'square');
  }

  private tone(
    freq: number,
    dur: number,
    vol: number,
    type: OscillatorType,
    endFreq?: number,
  ): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const t = this.now();
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
