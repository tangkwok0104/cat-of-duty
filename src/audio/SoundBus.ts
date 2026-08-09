import { bus } from '../core/EventBus';

/** Cat vocal sample keys — six generated CC0 clips wired in for the M-audio
 *  pass (see /assets/gen/audio). Every one keeps a synth fallback below in
 *  case its decode fails, so audio is never silently missing. */
type SampleName =
  | 'meow-battle'
  | 'hiss'
  | 'death-yowl'
  | 'growl-heavy'
  | 'chirp-alert'
  | 'meow-victory';

interface SampleEntry {
  status: 'loading' | 'loaded' | 'failed';
  buffer?: AudioBuffer;
}

type PlayResult = 'played' | 'throttled' | 'unavailable';

/** Slice audio: most cues are still raw WebAudio synths (original work,
 *  license-clean). Six recorded CC0 cat-vocal samples layer in on top of /
 *  in place of specific synth cues (see the BUILD SPEC event map in the
 *  constructor below) — each keeps its synth equivalent as a decode-failure
 *  fallback. The context resumes on the first pointer-lock click (autoplay
 *  policy); sample fetch+decode is lazily kicked off from that same
 *  unlock() call and never before, so boot never waits on network audio and
 *  no fetch fires before the browser has granted an audio gesture. */
export class SoundBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 0.32;

  // --- recorded-sample playback state ----------------------------------
  private static readonly SAMPLE_URLS: Record<SampleName, string> = {
    'meow-battle': '/assets/gen/audio/meow-battle.mp3',
    hiss: '/assets/gen/audio/hiss.mp3',
    'death-yowl': '/assets/gen/audio/death-yowl.mp3',
    'growl-heavy': '/assets/gen/audio/growl-heavy.mp3',
    'chirp-alert': '/assets/gen/audio/chirp-alert.mp3',
    'meow-victory': '/assets/gen/audio/meow-victory.mp3',
  };
  /** ±3% pitch variation expressed in cents (1200 * log2(1.03) ≈ 51). */
  private static readonly DETUNE_RANGE_CENTS = 51;
  private static readonly SAMPLE_MIN_GAP_MS = 250;

  private samples = new Map<SampleName, SampleEntry>();
  private lastPlayedAt = new Map<SampleName, number>();
  private warnedSamples = new Set<SampleName>();
  private samplesRequested = false;
  /** Every 3rd melee swipe alternates to hiss instead of meow-battle. */
  private meleeCount = 0;

  /** Master volume 0..1 (settings menu). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

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
    // A projectile hitting the player routes through player:damaged too, so
    // it reuses the same hurt grunt as melee — no separate impact sound.
    bus.on('player:damaged', () => this.hurt());
    bus.on('player:died', () => this.death());
    bus.on('enemy:fired', () => this.zap());
    bus.on('pickup:collected', ({ kind }) => this.pickup(kind));
    bus.on('weapon:acquired', () => this.weaponAcquired());

    // --- recorded cat vocals (M-audio pass) ------------------------------
    // Distance attenuation note: 'enemy:windup' carries x/z, but SoundBus is
    // constructed with no arguments (`new SoundBus()` in main.ts) and
    // GameState is not a singleton — it only exists as the per-boot `state`
    // object threaded into other systems. Reaching player position would
    // mean changing that construction site and this file's constructor
    // signature, and main.ts isn't a file this task owns. Took the cheap
    // route named in the brief instead: subscribe on the payload, fixed
    // volume, no falloff.
    bus.on('enemy:windup', () => {
      if (this.playSample('chirp-alert', 0.55) === 'unavailable') this.windupChirp();
    });
    bus.on('enemy:killed', () => {
      // Layered, not replaced: the existing kill-confirm tick above still
      // fires from 'enemy:hit' regardless — this adds the recorded yowl.
      if (this.playSample('death-yowl', 0.6) === 'unavailable') this.deathYowlFallback();
    });
    bus.on('enemy:spawned', ({ archetype }) => {
      if (archetype !== 'heavy') return;
      if (this.playSample('growl-heavy', 0.5) === 'unavailable') this.growlFallback();
    });
    bus.on('enemy:melee', () => {
      this.meleeCount++;
      const useHiss = this.meleeCount % 3 === 0;
      const name: SampleName = useHiss ? 'hiss' : 'meow-battle';
      const result = this.playSample(name, useHiss ? 0.5 : 0.55);
      if (result === 'unavailable') {
        if (useHiss) this.hissFallback();
        else this.meowBattleFallback();
      }
    });
    bus.on('wave:cleared', () => {
      if (this.playSample('meow-victory', 0.6) === 'unavailable') this.victoryFallback();
    });
  }

  private nextBeatAt = 0;

  /** Per-frame: heartbeat when wounded — cadence rises as hp falls. */
  tick(hpFraction: number, dead: boolean): void {
    if (dead || hpFraction >= 0.4 || !this.ctx) return;
    const now = this.now();
    if (now < this.nextBeatAt) return;
    // lub-dub
    this.tone(64, 0.1, 0.5, 'sine', 40);
    setTimeout(() => this.tone(52, 0.09, 0.4, 'sine', 36), 160);
    this.nextBeatAt = now + 0.5 + hpFraction * 1.5;
  }

  /** Call from a user gesture (pointer-lock click). */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    void this.ctx.resume();
    this.loadSamplesOnce();
  }

  /** Fetch+decode the six recorded samples exactly once, kicked off only
   *  from unlock() (i.e. only after a user gesture — never at boot). Not
   *  awaited by the caller: gameplay never blocks on this, and any event
   *  that fires before a given sample's decode resolves (or if it never
   *  does) just plays that event's synth fallback instead. */
  private loadSamplesOnce(): void {
    if (this.samplesRequested || !this.ctx) return;
    this.samplesRequested = true;
    const ctx = this.ctx;
    for (const name of Object.keys(SoundBus.SAMPLE_URLS) as SampleName[]) {
      this.samples.set(name, { status: 'loading' });
      fetch(SoundBus.SAMPLE_URLS[name])
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => {
          this.samples.set(name, { status: 'loaded', buffer });
          console.debug(`[SoundBus] decoded sample "${name}"`);
        })
        .catch((err: unknown) => {
          this.samples.set(name, { status: 'failed' });
          if (!this.warnedSamples.has(name)) {
            this.warnedSamples.add(name);
            console.warn(`[SoundBus] sample "${name}" failed to load — using synth fallback instead`, err);
          }
        });
    }
  }

  /** Play a decoded sample through the master bus with a small random
   *  detune and a per-sample 250ms throttle (never the same sample twice
   *  inside that window). Returns 'unavailable' when the sample never
   *  decoded (still loading, or failed) so the caller can play its synth
   *  fallback instead; returns 'throttled' when it decoded fine but was
   *  rate-limited — that case plays nothing, on purpose, no fallback. */
  private playSample(name: SampleName, volume: number): PlayResult {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return 'unavailable';
    const entry = this.samples.get(name);
    if (!entry || entry.status !== 'loaded' || !entry.buffer) return 'unavailable';
    const buffer = entry.buffer;

    const nowMs = performance.now();
    const lastAt = this.lastPlayedAt.get(name) ?? -Infinity;
    if (nowMs - lastAt < SoundBus.SAMPLE_MIN_GAP_MS) return 'throttled';
    this.lastPlayedAt.set(name, nowMs);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.detune.value = (Math.random() * 2 - 1) * SoundBus.DETUNE_RANGE_CENTS;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(out);
    src.start(this.now());
    return 'played';
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Gunshot: white-noise crack through a falling lowpass + a thump.
   *  Per-gun flavour: shotgun = longer/deeper boom, sniper = sharper crack,
   *  smg = the rifle pattern shortened and pitched up (900 rpm chatter). */
  private shot(profile: 'rifle' | 'shotgun' | 'sniper' | 'smg'): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const t = this.now();

    const noiseLen =
      profile === 'shotgun' ? 0.16 : profile === 'sniper' ? 0.12 : profile === 'smg' ? 0.07 : 0.09;
    const lpStart =
      profile === 'shotgun' ? 2600 : profile === 'sniper' ? 7000 : profile === 'smg' ? 6400 : 5200;
    const lpEnd = profile === 'shotgun' ? 220 : profile === 'smg' ? 700 : 500;
    const thumpF =
      profile === 'shotgun' ? 95 : profile === 'sniper' ? 180 : profile === 'smg' ? 200 : 150;
    const thumpVol = profile === 'rifle' ? 0.5 : profile === 'smg' ? 0.42 : 0.65;
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

  /** Enemy windup telegraph fallback (chirp-alert decode failed/pending):
   *  short rising two-tone chirp — the fair-warning cue that a gunner is
   *  about to fire. Square + high register so it cuts through gunfire at
   *  combat volume. */
  private windupChirp(): void {
    this.tone(660, 0.07, 0.5, 'square', 990);
    setTimeout(() => this.tone(990, 0.09, 0.55, 'square', 1480), 80);
  }

  /** Enemy projectile away: quick falling zap/pew — a pure-tone sweep, so
   *  it never reads as a player gun (those are noise-crack + thump). */
  private zap(): void {
    this.tone(1700, 0.09, 0.4, 'sawtooth', 260);
  }

  /** Pickup collected: bright rising ding — ammo pitched a touch higher
   *  than health, distinct enough without needing a whole second timbre. */
  private pickup(kind: 'health' | 'ammo'): void {
    const base = kind === 'ammo' ? 1320 : 1046;
    this.tone(base, 0.05, 0.4, 'sine', base * 1.5);
    setTimeout(() => this.tone(base * 1.5, 0.08, 0.35, 'sine'), 45);
  }

  /** New gun off the ground: quick rising three-note riff — the victory
   *  ding family (kill confirm / pickup), stretched into a little fanfare. */
  private weaponAcquired(): void {
    this.tone(660, 0.07, 0.4, 'square', 880);
    setTimeout(() => this.tone(990, 0.07, 0.4, 'square'), 70);
    setTimeout(() => this.tone(1320, 0.12, 0.45, 'square', 1760), 140);
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

  // --- synth fallbacks for the recorded samples above ------------------
  // Each mirrors the register/character of its recorded counterpart so a
  // failed decode degrades gracefully instead of going silent.

  /** Fallback if death-yowl failed to decode — short falling yelp. */
  private deathYowlFallback(): void {
    this.tone(700, 0.12, 0.4, 'sawtooth', 200);
  }

  /** Fallback if growl-heavy failed to decode — low rumble on spawn. */
  private growlFallback(): void {
    this.tone(90, 0.35, 0.35, 'sawtooth', 60);
  }

  /** Fallback if meow-battle failed to decode — short aggressive yowl. */
  private meowBattleFallback(): void {
    this.tone(520, 0.1, 0.4, 'sawtooth', 340);
  }

  /** Fallback if hiss failed to decode — filtered noise burst (reuses the
   *  shot() noise-buffer technique, pitched into hiss register). */
  private hissFallback(): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const t = this.now();
    const len = 0.18;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    noise.connect(hp).connect(g).connect(out);
    noise.start(t);
  }

  /** Fallback if meow-victory failed to decode — bright rising two-note. */
  private victoryFallback(): void {
    this.tone(660, 0.09, 0.4, 'sine', 990);
    setTimeout(() => this.tone(990, 0.12, 0.4, 'sine', 1320), 90);
  }
}
