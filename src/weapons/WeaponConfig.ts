/** Data-driven weapon definitions. A typed TS data module rather than raw
 *  JSON: same declarative shape, but the compiler guards every field and
 *  configs can reference shared curves. (Noted in PROGRESS as the judgment
 *  call vs .json files.) */

export interface FalloffCurve {
  /** Full damage up to this distance (m). */
  start: number;
  /** Damage bottoms out at this distance (m). */
  end: number;
  /** Multiplier at/after `end`. */
  minMult: number;
}

export interface WeaponConfig {
  id: 'rifle' | 'shotgun' | 'sniper' | 'smg';
  name: string;
  auto: boolean;
  rpm: number;
  /** Damage per bullet/pellet before falloff/headshot. */
  damage: number;
  headshotMult: number;
  pellets: number;
  falloff: FalloffCurve;
  /** Hip-fire cone half-angle in degrees; ADS cone. */
  spreadHipDeg: number;
  spreadAdsDeg: number;
  mag: number;
  reserveStart: number;
  reloadS: number;
  adsFov: number;
  adsTimeS: number;
  /** Consecutive-shot camera kicks [pitchUp, yawRight] in radians; the
   *  pattern index resets after `recoilResetS` without firing. */
  recoilPattern: readonly (readonly [number, number])[];
  recoilResetS: number;
  /** How many surfaces a bullet can punch through (0 = none). */
  penetration: number;
  /** Damage multiplier after each punch-through. */
  penetrationMult: number;
  tracer: boolean;
  /** Sound flavour for the synth bus. */
  soundProfile: 'rifle' | 'shotgun' | 'sniper' | 'smg';
  /** Viewmodel silhouette parameters (box-gun builder — placeholder shown
   *  until the real GLB below finishes loading). */
  model: {
    barrelLen: number;
    barrelRadius: number;
    receiverLen: number;
    magH: number;
    scope: boolean;
    pump: boolean;
  };
  /** Real GLB viewmodel (Assets.loadModel(file)), placed inside the same
   *  per-gun group the box placeholder occupies. The GLB's long axis is
   *  world +X with the muzzle at local -X (verified by bounding-box probe,
   *  see .tmp/glb-bbox.ts); rotation.y = -PI/2 turns that into local -Z
   *  (away from camera) to match the placeholder's barrel convention.
   *  `muzzleLocal` is the muzzle tip in the GLB's own untransformed space —
   *  scale→rotate→translate turns it into the flash/tracer anchor. */
  viewModel: {
    file: string;
    scale: number;
    position: readonly [number, number, number];
    rotation: readonly [number, number, number];
    muzzleLocal: readonly [number, number, number];
    /** Cat-paw grip prop (paw.glb, loaded once and cloned per gun — see
     *  Viewmodel.loadPaw). Transform is in the same gun-local space as
     *  `position`/`rotation` above: wraps the pistol-grip area with the
     *  forearm trailing off toward the bottom-right screen edge (the
     *  player's shoulder). Omit to ship this gun corner-anchored without a
     *  paw if the grip fights the gun's geometry. */
    paw?: {
      scale: number;
      position: readonly [number, number, number];
      rotation: readonly [number, number, number];
    };
  };
}

const R = (p: number, y: number): readonly [number, number] => [p, y] as const;

export const WEAPONS: readonly WeaponConfig[] = [
  {
    id: 'rifle',
    name: 'PAWS-15',
    auto: true,
    rpm: 600,
    damage: 30,
    headshotMult: 2,
    pellets: 1,
    falloff: { start: 22, end: 60, minMult: 0.6 },
    spreadHipDeg: 1.6,
    spreadAdsDeg: 0.25,
    mag: 30,
    reserveStart: 90,
    reloadS: 2.0,
    adsFov: 55,
    adsTimeS: 0.15,
    // Gentle rise, drifting right then back — learnable, not punishing.
    recoilPattern: [
      R(0.014, 0.000), R(0.016, 0.001), R(0.018, 0.002), R(0.02, 0.003),
      R(0.021, 0.004), R(0.022, 0.002), R(0.022, -0.002), R(0.023, -0.004),
      R(0.023, -0.002), R(0.024, 0.002), R(0.024, 0.004), R(0.024, 0.0),
    ],
    recoilResetS: 0.35,
    penetration: 0,
    penetrationMult: 0.5,
    tracer: true,
    soundProfile: 'rifle',
    model: { barrelLen: 0.24, barrelRadius: 0.014, receiverLen: 0.3, magH: 0.11, scope: false, pump: false },
    viewModel: {
      file: 'rifle',
      scale: 0.115,
      position: [0, -0.055, -0.2],
      rotation: [0, -Math.PI / 2 + 0.15, 0],
      muzzleLocal: [-0.95, -0.02, 0],
      paw: {
        scale: 0.095,
        position: [0.01, -0.065, -0.02],
        rotation: [0.4, -0.5, -2.356],
      },
    },
  },
  {
    id: 'shotgun',
    name: 'SCRATCH-12',
    auto: false,
    rpm: 75,
    // 8 pellets × 14 = 112 point-blank: a clean full blast one-pulls a base
    // cat (12×8=96 left survivors on 4hp — felt terrible, probe-verified).
    damage: 14,
    headshotMult: 1.5,
    pellets: 8,
    falloff: { start: 6, end: 18, minMult: 0.25 },
    spreadHipDeg: 4.2,
    spreadAdsDeg: 3.0,
    mag: 6,
    reserveStart: 24,
    reloadS: 2.6,
    adsFov: 62,
    adsTimeS: 0.18,
    recoilPattern: [R(0.055, 0.0), R(0.06, 0.006), R(0.06, -0.006)],
    recoilResetS: 0.8,
    penetration: 0,
    penetrationMult: 0.5,
    tracer: false,
    soundProfile: 'shotgun',
    model: { barrelLen: 0.3, barrelRadius: 0.022, receiverLen: 0.26, magH: 0.05, scope: false, pump: true },
    viewModel: {
      file: 'shotgun',
      scale: 0.1,
      position: [0, -0.015, -0.24],
      rotation: [0.38, -Math.PI / 2 + 0.15, 0],
      muzzleLocal: [-0.95, 0.05, 0],
      paw: {
        scale: 0.09,
        position: [0.01, -0.035, -0.05],
        rotation: [0.4, -0.5, -2.356],
      },
    },
  },
  {
    id: 'sniper',
    name: 'LONGWHISKER',
    auto: false,
    rpm: 45,
    damage: 105,
    headshotMult: 2,
    pellets: 1,
    falloff: { start: 999, end: 1000, minMult: 1 },
    spreadHipDeg: 6.0, // no-scoping is a prayer
    spreadAdsDeg: 0.0,
    mag: 5,
    reserveStart: 20,
    reloadS: 3.0,
    adsFov: 30,
    adsTimeS: 0.28,
    recoilPattern: [R(0.09, 0.008)],
    recoilResetS: 1.2,
    penetration: 1, // punches through one crate/cat
    penetrationMult: 0.7,
    tracer: true,
    soundProfile: 'sniper',
    model: { barrelLen: 0.42, barrelRadius: 0.012, receiverLen: 0.34, magH: 0.07, scope: true, pump: false },
    viewModel: {
      file: 'sniper',
      scale: 0.13,
      position: [0, -0.045, -0.22],
      rotation: [0, -Math.PI / 2 + 0.15, 0],
      muzzleLocal: [-0.95, -0.03, 0],
      paw: {
        scale: 0.1,
        position: [0.01, -0.06, -0.01],
        rotation: [0.4, -0.5, -2.356],
      },
    },
  },
  {
    id: 'smg',
    name: 'PURR-90',
    auto: true,
    rpm: 900,
    // 15 rounds/s × 16 = 240 DPS: below the rifle's 300 but with a 50-round
    // mag — the hose you spray when cats swarm, not the precision pick.
    damage: 16,
    headshotMult: 2,
    pellets: 1,
    // Shortish reach: full damage inside room-fight range, falls off fast.
    falloff: { start: 12, end: 32, minMult: 0.5 },
    spreadHipDeg: 2.0, // a touch wider than the rifle's 1.6
    spreadAdsDeg: 0.35,
    mag: 50,
    reserveStart: 100,
    reloadS: 2.2,
    adsFov: 58,
    adsTimeS: 0.12, // snappiest ADS in the roster — the run-and-gun pick
    // Many tiny kicks with a lazy left-right wander: high rate + small
    // per-shot rise = a controllable spray that still climbs if mashed.
    recoilPattern: [
      R(0.008, 0.000), R(0.009, 0.001), R(0.010, 0.002), R(0.010, 0.003),
      R(0.011, 0.002), R(0.011, 0.000), R(0.011, -0.002), R(0.012, -0.003),
      R(0.012, -0.002), R(0.012, 0.000), R(0.012, 0.002), R(0.012, 0.003),
      R(0.012, 0.001), R(0.012, -0.001), R(0.012, -0.003), R(0.012, 0.000),
    ],
    recoilResetS: 0.25,
    penetration: 0,
    penetrationMult: 0.5,
    tracer: true,
    soundProfile: 'smg',
    model: { barrelLen: 0.16, barrelRadius: 0.012, receiverLen: 0.22, magH: 0.14, scope: false, pump: false },
    // smg.glb bbox (probe .tmp/smg-bbox.ts): x[-0.842,0.841] y[-0.950,0.948]
    // z[-0.146,0.144] — muzzle at -X like the other guns; the tall Y span is
    // its skeletal amber sight (up) + long magazine (down). Barrel line sits
    // ~0.12 above local origin, hence the muzzleLocal y.
    viewModel: {
      file: 'smg',
      scale: 0.1,
      // y tuned by screenshot vs the rifle's ADS standard (sights just under
      // centre): -0.06 left the peep ring far low; -0.03 matches the roster.
      position: [0, -0.03, -0.18],
      rotation: [0, -Math.PI / 2 + 0.15, 0],
      muzzleLocal: [-0.84, 0.12, 0],
      paw: {
        scale: 0.085,
        position: [0.01, -0.05, 0.0],
        rotation: [0.4, -0.5, -2.356],
      },
    },
  },
];
