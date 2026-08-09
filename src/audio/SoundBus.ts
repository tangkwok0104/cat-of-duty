import { bus } from '../core/EventBus';

/** Recorded sample keys. Six cat-vocal clips (M-audio pass) plus eight
 *  weapon SFX clips (M-audio-2 pass): per-gun shots, reload foley, dry-fire
 *  click, a concrete-impact thud, and an enemy-projectile whoosh — all
 *  under /assets/gen/audio. Every one keeps a synth fallback below in case
 *  its decode fails (or, new in this pass, decodes to near-silence — see
 *  MIN_SAMPLE_PEAK), so audio is never silently missing or silently broken. */
type SampleName =
  | 'meow-battle'
  | 'hiss'
  | 'death-yowl'
  | 'growl-heavy'
  | 'chirp-alert'
  | 'meow-victory'
  | 'shot-rifle'
  | 'shot-shotgun'
  | 'shot-sniper'
  | 'shot-smg'
  | 'reload'
  | 'dryfire'
  | 'impact-concrete'
  | 'projectile-whoosh';

interface SampleEntry {
  status: 'loading' | 'loaded' | 'failed';
  buffer?: AudioBuffer;
}

type PlayResult = 'played' | 'throttled' | 'unavailable';

// -----------------------------------------------------------------------
// MIX PASS — central gain table (M-audio-2). Linear 0..1, each one the gain
// on a node feeding SoundBus's master bus, so every number is "relative
// loudness at max settings-menu volume" — the master volume slider still
// scales everything below it (see unlock()/setVolume()). These are starting
// points from listening once during the build; final in-game balance needs
// a human ear pass on real hardware/headphones.
// -----------------------------------------------------------------------
/** Player gunfire (rifle/shotgun/sniper/smg) — the loudest thing in the
 *  mix on purpose: the player's own gun should always read over everything
 *  else happening on screen. */
const GAIN_PLAYER_SHOT = 0.9;
/** Reload foley + dry-fire click. */
const GAIN_RELOAD_DRY = 0.6;
/** Bullet-hits-world-geometry thud (weapon:impact). Background texture the
 *  player isn't meant to consciously track, so it sits low in the mix. */
const GAIN_IMPACT = 0.35;
/** Enemy projectile flyby — layered *under* the existing zap() cue, not
 *  replacing it, so it stays subordinate to the tone that already reads as
 *  "incoming fire." */
const GAIN_PROJECTILE_WHOOSH = 0.4;
/** All six recorded cat-vocal samples (battle meow / hiss / death yowl /
 *  heavy growl / alert chirp / victory meow). These were previously hand-
 *  tuned per cue between 0.5 and 0.6; consolidated to one value here per
 *  the mix-pass spec — the differences were minor and not worth a second
 *  table. */
const GAIN_CAT_VOCAL = 0.55;
/** Pickup dings + the weapon-acquired fanfare. */
const GAIN_UI_DING = 0.45;
// Heartbeat / low-hp vignette cue (tick()) is intentionally untouched by
// this pass — it's diegetic player-state feedback, a different mix concern
// from the combat SFX above, and nothing in the brief asked for it.

/** Slice audio: most cues are still raw WebAudio synths (original work,
 *  license-clean). Fourteen recorded CC0 samples layer in on top of / in
 *  place of specific synth cues (see the event map in the constructor
 *  below) — each keeps its synth equivalent as a fallback for either a
 *  decode failure or a decode that comes back functionally silent. The
 *  context resumes on the first pointer-lock click (autoplay policy);
 *  sample fetch+decode is lazily kicked off from that same unlock() call
 *  and never before, so boot never waits on network audio and no fetch
 *  fires before the browser has granted an audio gesture. */
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
    'shot-rifle': '/assets/gen/audio/shot-rifle.mp3',
    'shot-shotgun': '/assets/gen/audio/shot-shotgun.mp3',
    'shot-sniper': '/assets/gen/audio/shot-sniper.mp3',
    'shot-smg': '/assets/gen/audio/shot-smg.mp3',
    reload: '/assets/gen/audio/reload.mp3',
    dryfire: '/assets/gen/audio/dryfire.mp3',
    'impact-concrete': '/assets/gen/audio/impact-concrete.mp3',
    'projectile-whoosh': '/assets/gen/audio/projectile-whoosh.mp3',
  };
  /** Which recorded sample backs each weapon profile's 'weapon:fired'. */
  private static readonly SHOT_SAMPLE_BY_PROFILE: Record<
    'rifle' | 'shotgun' | 'sniper' | 'smg',
    SampleName
  > = {
    rifle: 'shot-rifle',
    shotgun: 'shot-shotgun',
    sniper: 'shot-sniper',
    smg: 'shot-smg',
  };
  /** ±3% pitch variation expressed in cents (1200 * log2(1.03) ≈ 51) —
   *  default for every sample. */
  private static readonly DETUNE_RANGE_CENTS = 51;
  /** ±4% (1200 * log2(1.04) ≈ 68) for the four gunshot samples — wider than
   *  the vocal default specifically so rapid retrigger (SMG @ 900rpm, one
   *  'weapon:fired' per shot) doesn't read as an obviously looped one-shot. */
  private static readonly SAMPLE_DETUNE_OVERRIDES_CENTS: Partial<Record<SampleName, number>> = {
    'shot-rifle': 68,
    'shot-shotgun': 68,
    'shot-sniper': 68,
    'shot-smg': 68,
  };
  /** Default per-sample retrigger floor — fine for one-off cues (a cat
   *  yowling, a pickup ding) where two plays inside a quarter-second would
   *  just be flanging, not two distinct events. */
  private static readonly SAMPLE_MIN_GAP_MS = 250;
  /** Per-sample overrides where the default would eat real events. SMG at
   *  900rpm fires 15 times/sec (~66ms apart) — the 250ms default would
   *  silently drop roughly every other shot's sample layer, so every gun
   *  sample (and the full-auto dry-click, which can fire at the same
   *  cadence on an empty mag) gets a 40ms floor instead: comfortably below
   *  any weapon's real rate of fire, still enough to dedupe true audio
   *  glitches (e.g. two collider surfaces hit in the same frame). */
  private static readonly SAMPLE_MIN_GAP_OVERRIDES_MS: Partial<Record<SampleName, number>> = {
    'shot-rifle': 40,
    'shot-shotgun': 40,
    'shot-sniper': 40,
    'shot-smg': 40,
    dryfire: 40,
    'impact-concrete': 80, // BUILD SPEC value; also reused as the fallback-synth's own throttle floor (see weapon:impact handler)
  };
  /** Per-sample start offset, for trimming leading silence instead of
   *  re-encoding the asset. shot-shotgun.mp3 has ~1.24s of near-silent
   *  lead-in before the actual boom+pump — measured with
   *  `ffmpeg -af silencedetect=noise=-30dB:d=0.05`, not eyeballed — so
   *  playback starts just before the real transient instead of after a
   *  sluggish dead-air gap. */
  private static readonly SAMPLE_START_OFFSET_SEC: Partial<Record<SampleName, number>> = {
    'shot-shotgun': 1.24,
  };
  /** Below this linear peak amplitude (~-40 dBFS) a "successfully decoded"
   *  sample is treated as a broken generation rather than real audio.
   *  Calibrated against the actual files, not guessed: the quietest
   *  already-shipped vocal sample (chirp-alert) peaks at -38.9 dBFS and
   *  must keep working, while several of this pass's new weapon SFX came
   *  back from generation at -41 to -57 dBFS peak with no transient
   *  structure at all under a spectrogram — just noise floor. Below the
   *  line, status goes to 'failed' exactly like a real decode failure, so
   *  the synth fallback takes over and a broken generation never ships as
   *  if it were the "improved" sound. */
  private static readonly MIN_SAMPLE_PEAK = 0.01;

  private samples = new Map<SampleName, SampleEntry>();
  private lastPlayedAt = new Map<SampleName, number>();
  private warnedSamples = new Set<SampleName>();
  private samplesRequested = false;
  /** Every 3rd melee swipe alternates to hiss instead of meow-battle. */
  private meleeCount = 0;
  /** Throttle floor for impactFallback() specifically — playSample() never
   *  touches lastPlayedAt for a permanently-'failed' sample (it returns
   *  'unavailable' before that point), so without this a wall full of
   *  shotgun pellets would fire the fallback thud once per pellet per
   *  frame with no rate limit at all. */
  private lastImpactFallbackAt = -Infinity;

  /** Master volume 0..1 (settings menu). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  constructor() {
    bus.on('weapon:fired', ({ profile }) => {
      const sample = SoundBus.SHOT_SAMPLE_BY_PROFILE[profile];
      if (this.playSample(sample, GAIN_PLAYER_SHOT) === 'unavailable') this.shot(profile);
    });
    bus.on('weapon:dry', () => {
      if (this.playSample('dryfire', GAIN_RELOAD_DRY) === 'unavailable') {
        this.click(1200, 0.04, 0.25);
      }
    });
    bus.on('weapon:reload-start', () => {
      if (this.playSample('reload', GAIN_RELOAD_DRY) === 'unavailable') {
        this.click(700, 0.05, 0.3);
      }
    });
    bus.on('weapon:reload-end', () => this.click(1000, 0.05, 0.35));
    bus.on('weapon:switched', () => this.click(880, 0.04, 0.25));
    bus.on('weapon:impact', () => {
      if (this.playSample('impact-concrete', GAIN_IMPACT) === 'unavailable') {
        const nowMs = performance.now();
        const gap = SoundBus.SAMPLE_MIN_GAP_OVERRIDES_MS['impact-concrete'] ?? SoundBus.SAMPLE_MIN_GAP_MS;
        if (nowMs - this.lastImpactFallbackAt < gap) return;
        this.lastImpactFallbackAt = nowMs;
        this.impactFallback();
      }
    });
    bus.on('enemy:hit', ({ killed, part }) => {
      // Hit-confirm tiers: the body/headshot timbre always fires first —
      // killLayer() only ADDS a resolving low tone on top of it, it never
      // replaces it, so a killing headshot still sounds like a headshot.
      this.hit(part === 'head');
      if (killed) this.killLayer();
    });
    // A projectile hitting the player routes through player:damaged too, so
    // it reuses the same hurt grunt as melee — no separate impact sound.
    bus.on('player:damaged', () => this.hurt());
    bus.on('player:died', () => this.death());
    bus.on('enemy:fired', () => {
      this.zap();
      // Layer only, on purpose: zap() already fully covers this cue on its
      // own (that's the pre-existing behaviour), so the whoosh sample gets
      // no synth fallback of its own — if it's unavailable this just plays
      // nothing extra, which is silently correct.
      this.playSample('projectile-whoosh', GAIN_PROJECTILE_WHOOSH);
    });
    bus.on('pickup:collected', ({ kind }) => this.pickup(kind));
    bus.on('weapon:acquired', () => this.weaponAcquired());
    bus.on('player:footstep', ({ sprinting, crouching }) => this.footstep(sprinting, crouching));
    bus.on('score:streak', ({ tier }) => this.streakSting(tier));

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
      if (this.playSample('chirp-alert', GAIN_CAT_VOCAL) === 'unavailable') this.windupChirp();
    });
    bus.on('enemy:killed', () => {
      // Layered, not replaced: the existing kill-confirm tick above still
      // fires from 'enemy:hit' regardless — this adds the recorded yowl.
      if (this.playSample('death-yowl', GAIN_CAT_VOCAL) === 'unavailable') this.deathYowlFallback();
    });
    bus.on('enemy:spawned', ({ archetype }) => {
      if (archetype !== 'heavy') return;
      if (this.playSample('growl-heavy', GAIN_CAT_VOCAL) === 'unavailable') this.growlFallback();
    });
    bus.on('enemy:melee', () => {
      this.meleeCount++;
      const useHiss = this.meleeCount % 3 === 0;
      const name: SampleName = useHiss ? 'hiss' : 'meow-battle';
      const result = this.playSample(name, GAIN_CAT_VOCAL);
      if (result === 'unavailable') {
        if (useHiss) this.hissFallback();
        else this.meowBattleFallback();
      }
    });
    bus.on('wave:cleared', () => {
      if (this.playSample('meow-victory', GAIN_CAT_VOCAL) === 'unavailable') this.victoryFallback();
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

  /** Fetch+decode the fourteen recorded samples exactly once, kicked off
   *  only from unlock() (i.e. only after a user gesture — never at boot).
   *  Not awaited by the caller: gameplay never blocks on this, and any
   *  event that fires before a given sample's decode resolves (or if it
   *  never does, or if it decodes to near-silence — see MIN_SAMPLE_PEAK)
   *  just plays that event's synth fallback instead. */
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
          const peak = SoundBus.samplePeak(buffer);
          console.debug(`[SoundBus] decoded sample "${name}" (peak ${peak.toFixed(3)})`);
          if (peak < SoundBus.MIN_SAMPLE_PEAK) {
            this.samples.set(name, { status: 'failed' });
            if (!this.warnedSamples.has(name)) {
              this.warnedSamples.add(name);
              console.warn(
                `[SoundBus] sample "${name}" decoded but is near-silent (peak ${peak.toFixed(3)}, ` +
                  `floor ${SoundBus.MIN_SAMPLE_PEAK}) — treating as a broken generation, using synth fallback instead`,
              );
            }
            return;
          }
          this.samples.set(name, { status: 'loaded', buffer });
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

  /** Peak absolute sample value across every channel. Runs once per sample
   *  at decode time (never per-frame) — cost is a single linear scan of a
   *  1-2.5s buffer, not a hot-path concern. */
  private static samplePeak(buffer: AudioBuffer): number {
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] ?? 0);
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  /** Play a decoded sample through the master bus with a small random
   *  detune and a per-sample retrigger throttle (see
   *  SAMPLE_MIN_GAP_OVERRIDES_MS — never the same sample twice inside that
   *  window). Returns 'unavailable' when the sample never decoded to usable
   *  audio (still loading, failed, or gated as near-silent) so the caller
   *  can play its synth fallback instead; returns 'throttled' when it
   *  decoded fine but was rate-limited — that case plays nothing, on
   *  purpose, no fallback. */
  private playSample(name: SampleName, volume: number): PlayResult {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return 'unavailable';
    const entry = this.samples.get(name);
    if (!entry || entry.status !== 'loaded' || !entry.buffer) return 'unavailable';
    const buffer = entry.buffer;

    const nowMs = performance.now();
    const lastAt = this.lastPlayedAt.get(name) ?? -Infinity;
    const minGap = SoundBus.SAMPLE_MIN_GAP_OVERRIDES_MS[name] ?? SoundBus.SAMPLE_MIN_GAP_MS;
    if (nowMs - lastAt < minGap) return 'throttled';
    this.lastPlayedAt.set(name, nowMs);

    const detune = SoundBus.SAMPLE_DETUNE_OVERRIDES_CENTS[name] ?? SoundBus.DETUNE_RANGE_CENTS;
    const offset = SoundBus.SAMPLE_START_OFFSET_SEC[name] ?? 0;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.detune.value = (Math.random() * 2 - 1) * detune;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(out);
    src.start(this.now(), offset);
    return 'played';
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Gunshot synth fallback (used when the matching shot-* sample hasn't
   *  decoded, failed, or gated as near-silent): white-noise crack through a
   *  falling lowpass + a thump. Per-gun flavour: shotgun = longer/deeper
   *  boom, sniper = sharper crack, smg = the rifle pattern shortened and
   *  pitched up (900 rpm chatter). */
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

  /** Hit-confirm tiers (research-backed load-bearing feedback, see
   *  .tmp/research-aaa-feel.md §1/§2). Body and headshot get genuinely
   *  different timbres — not the same click just pitched up — so the ear
   *  can tell them apart without looking at the on-screen hitmarker. */
  private hit(head: boolean): void {
    if (head) this.hitHeadshot();
    else this.hitBody();
  }

  /** Body hit: short dry click/thud, mid frequency. Gain sits in the
   *  GAIN_UI_DING neighbourhood per the mix-pass spec — audible over
   *  gunfire, not fatiguing at SMG fire rates. No retrigger throttle here
   *  on purpose: hit-confirms are per-hit information and must never be
   *  dropped during rapid fire. */
  private hitBody(): void {
    this.click(900, 0.035, 0.5);
  }

  /** Headshot: sharper, brighter percussive tick. Built as a highpassed
   *  noise transient (not just a higher-pitched click) with a thin tone
   *  layered on top for pitch identity — a genuinely different timbre from
   *  hitBody(), not the same cue turned up. */
  private hitHeadshot(): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const t = this.now();
    const len = 0.02;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    noise.connect(hp).connect(g).connect(out);
    noise.start(t);
    this.tone(2600, 0.02, 0.35, 'square');
  }

  /** Kill layer: short resolving low tone with a slight downward pitch,
   *  layered ON TOP of whichever hit() cue just fired above (see the
   *  enemy:hit handler) — never a replacement, so a killing headshot still
   *  reads as a headshot with this added underneath. */
  private killLayer(): void {
    this.tone(220, 0.1, 0.4, 'sine', 150);
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
   *  it never reads as a player gun (those are noise-crack + thump). The
   *  projectile-whoosh sample layers under this (see enemy:fired handler);
   *  this synth always plays regardless of that sample's availability. */
  private zap(): void {
    this.tone(1700, 0.09, 0.4, 'sawtooth', 260);
  }

  /** Fallback for weapon:impact when impact-concrete didn't decode to
   *  usable audio (still loading, failed, or near-silent). Bullet-hits-wall
   *  had no dedicated sound at all before this pass — impacts.spawn() only
   *  ever drove the dust-mote particles — so there's no prior synth to
   *  reuse; this is new, built the same noise-through-lowpass shape as the
   *  other cues in this file, just shorter/duller/quieter (a knock, not a
   *  gunshot). Throttled by the caller (weapon:impact handler above), not
   *  here — a shotgun's 8 pellets can all hit the same wall in one frame. */
  private impactFallback(): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const t = this.now();
    const len = 0.05;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(GAIN_IMPACT, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    noise.connect(lp).connect(g).connect(out);
    noise.start(t);
  }

  /** Pickup collected: bright rising ding — ammo pitched a touch higher
   *  than health, distinct enough without needing a whole second timbre. */
  private pickup(kind: 'health' | 'ammo'): void {
    const base = kind === 'ammo' ? 1320 : 1046;
    this.tone(base, 0.05, GAIN_UI_DING, 'sine', base * 1.5);
    setTimeout(() => this.tone(base * 1.5, 0.08, GAIN_UI_DING * 0.8, 'sine'), 45);
  }

  /** New gun off the ground: quick rising three-note riff — the victory
   *  ding family (kill confirm / pickup), stretched into a little fanfare. */
  private weaponAcquired(): void {
    this.tone(660, 0.07, GAIN_UI_DING * 0.9, 'square', 880);
    setTimeout(() => this.tone(990, 0.07, GAIN_UI_DING * 0.9, 'square'), 70);
    setTimeout(() => this.tone(1320, 0.12, GAIN_UI_DING, 'square', 1760), 140);
  }

  /** Footstep scuff: short filtered-noise burst, subtle background texture
   *  — not meant to be consciously tracked, just presence under the player.
   *  Crouching drops to about half gain and a duller filter (sneaking
   *  should sound like sneaking); sprinting nudges gain and brightness up.
   *  Cutoff + gain both get a small per-step jitter so a steady run cadence
   *  never resolves into an obviously looped one-shot. */
  private footstep(sprinting: boolean, crouching: boolean): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out) return;
    const t = this.now();
    const len = 0.05 + Math.random() * 0.02; // 50-70ms
    const baseVol = 0.14;
    const vol =
      (crouching ? baseVol * 0.5 : sprinting ? baseVol * 1.25 : baseVol) * (0.85 + Math.random() * 0.3);
    const lpBase = crouching ? 1400 : sprinting ? 3200 : 2200;
    const lp = lpBase * (0.9 + Math.random() * 0.2);
    const buffer = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    noise.connect(filter).connect(g).connect(out);
    noise.start(t);
  }

  /** Streak sting: rising two-note synth cue on a kill-chain tier RISE
   *  (the bus only fires this on tier increase, never per-kill — see
   *  EventBus's 'score:streak' doc). Reuses the shape the old kill-confirm
   *  cue used (rising two-note, x1.5 the anchor freq) since it already read
   *  as "escalating" — just tier-scaled: higher anchor pitch and, at tier
   *  3, a brighter waveform, so the biggest chain doesn't just sound like
   *  the same twinkle turned up. */
  private streakSting(tier: 1 | 2 | 3): void {
    const anchor = 660 + (tier - 1) * 220; // 660 / 880 / 1100
    const type: OscillatorType = tier === 3 ? 'sawtooth' : 'square';
    const vol = 0.4 + (tier - 1) * 0.05;
    this.tone(anchor, 0.05, vol, type);
    setTimeout(() => this.tone(anchor * 1.5, 0.07, vol, type), 45);
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

  // --- synth fallbacks for the recorded cat-vocal samples ---------------
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
