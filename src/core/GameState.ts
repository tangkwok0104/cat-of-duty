/** Single source of truth. Systems read from and write to this object;
 *  sibling systems never import each other directly. */

export interface StaticColliderSpec {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  /** Yaw in radians — colliders must match their visuals' rotation. */
  rotY: number;
}

export interface DynamicBoxSpec {
  x: number;
  y: number;
  z: number;
  half: number;
}

export interface LevelData {
  staticColliders: StaticColliderSpec[];
  dynamicBoxes: DynamicBoxSpec[];
}

/** Physics writes crate transforms here (SoA, preallocated — the render
 *  loop interpolates prev→curr without allocating). */
export interface CrateBuffers {
  count: number;
  prevPos: Float32Array;
  currPos: Float32Array;
  prevRot: Float32Array; // quaternions, xyzw
  currRot: Float32Array;
}

/** Player simulation state. Physics writes position/grounded; the player
 *  module writes look angles, feel offsets and eye height; render reads. */
export interface PlayerState {
  // Capsule CENTER, interpolatable (prev = last physics step, curr = now).
  prevX: number; prevY: number; prevZ: number;
  currX: number; currY: number; currZ: number;
  /** Look angles in radians. Applied to the camera the SAME frame the mouse
   *  moves — never interpolated, never smoothed. */
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  sprinting: boolean;
  /** Horizontal speed (m/s) after the last physics step — drives bob. */
  speed2D: number;
  /** |vertical velocity| at the moment of landing; CameraFeel consumes it. */
  landingImpact: number;
  /** Camera offset above the capsule centre (crouch-lerped by CameraFeel). */
  eyeOffset: number;
  // Camera-feel offsets, written per render frame (transform-only feel).
  bobX: number;
  bobY: number;
  punchPitch: number;
  /** Raw mouse delta consumed THIS frame (px) — weapon sway reads it. */
  lookDeltaX: number;
  lookDeltaY: number;
}

/** Desired movement, written by the player FSM each fixed step and consumed
 *  by the physics character controller. */
export interface PlayerIntent {
  /** Normalised world-space wish direction. */
  wishX: number;
  wishZ: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
}

/** Live-tunable feel values (Tweakpane panel binds straight to this). */
export interface Tuning {
  sensitivity: number; // rad per px
  walkSpeed: number;
  sprintMult: number;
  crouchMult: number;
  groundAccel: number;
  airAccel: number;
  stopDecel: number;
  jumpVel: number;
  gravity: number;
  coyoteMs: number;
  jumpBufferMs: number;
  bobAmp: number;
  bobFreq: number;
  punchScale: number;
  baseFov: number;
}

export function defaultTuning(): Tuning {
  return {
    sensitivity: 0.0022,
    walkSpeed: 5.2,
    sprintMult: 1.55,
    crouchMult: 0.5,
    groundAccel: 60,
    airAccel: 12,
    stopDecel: 90,
    jumpVel: 7.2,
    gravity: -22,
    coyoteMs: 120,
    jumpBufferMs: 100,
    bobAmp: 0.035,
    bobFreq: 1.9,
    punchScale: 0.028,
    baseFov: 72,
  };
}

export interface PerfState {
  /** Last frame's wall-clock duration in ms. */
  frameMs: number;
  /** Draw calls of the last rendered frame (all passes included). */
  drawCalls: number;
  triangles: number;
  /** JS heap in MB if the browser exposes it, else -1. */
  heapMB: number;
}

export type QualityTier = 0 | 1 | 2 | 3 | 4;

export interface AmmoSlot {
  ammo: number;
  reserve: number;
}

/** Three-gun loadout (M3); configs live in weapons/WeaponConfig.ts. */
export interface WeaponState {
  /** Active loadout slot (0 rifle / 1 shotgun / 2 sniper). */
  slot: number;
  slots: AmmoSlot[];
  reloading: boolean;
  reloadEndsAt: number;
  /** Weapon-switch lower/raise progress: >0 means mid-switch. */
  switchingUntil: number;
  /** ADS blend 0 (hip) → 1 (sights). */
  ads: number;
  /** Additive camera recoil (spring-recovered — aim returns). */
  recoilPitch: number;
  recoilYaw: number;
  /** Muzzle flash time-to-live in seconds (>0 = visible). */
  flashTtl: number;
  lastShotAt: number;
  /** Active gun's ADS target FOV (render lerps toward it via `ads`). */
  adsFov: number;
  /** Fully scoped in (sniper at full ADS): hide viewmodel, show overlay. */
  scoped: boolean;
}

export interface HealthState {
  hp: number;
  dead: boolean;
  lastDamageAt: number;
}

export interface ScoreState {
  kills: number;
  wave: number;
  catsAlive: number;
  /** Points: 100/kill, ×1.5 headshot, × combo multiplier. */
  score: number;
  /** Kill-chain multiplier (1..8), decays 4s after the last kill. */
  combo: number;
  comboEndsAt: number;
  /** Accuracy tracking (trigger pulls that hit ≥1 enemy / total pulls). */
  shots: number;
  hits: number;
  /** Best score this browser (localStorage). */
  best: number;
}

export type CatPhase = 'alive' | 'dying';

export interface CatData {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  phase: CatPhase;
  /** Movement speed (m/s), varied per cat. */
  speed: number;
  /** Seconds of hit-flinch remaining. */
  flinch: number;
  /** Seconds until this cat may claw the player again. */
  attackCooldown: number;
  /** Wall-clock seconds since death (drives fall-over + despawn). */
  deadFor: number;
}

export interface EnemyColliderRef {
  id: number;
  part: 'head' | 'body';
}

export interface GameState {
  ready: boolean;
  level: LevelData;
  crates: CrateBuffers | null;
  weapon: WeaponState;
  health: HealthState;
  score: ScoreState;
  cats: CatData[];
  /** Rapier collider handle → which cat + which part (for hitscan). */
  colliderToEnemy: Map<number, EnemyColliderRef>;
  /** Spawn/remove request queues (enemies → physics). */
  enemySpawnQueue: { id: number; x: number; z: number }[];
  enemyRemoveQueue: number[];
  /** Harness-only: freeze cat movement so aimed-shot tests are
   *  deterministic. Never set by game code. */
  debugFreezeCats: boolean;
  player: PlayerState;
  playerIntent: PlayerIntent;
  /** One-shot teleport mailbox (debug/harness → physics). */
  playerTeleport: { x: number; y: number; z: number; yaw: number; pitch: number } | null;
  tuning: Tuning;
  /** 'player' = camera follows the player rig; 'debug' = posed by the debug
   *  API / perf harness. */
  cameraMode: 'player' | 'debug';
  quality: { tier: QualityTier; auto: boolean };
  perf: PerfState;
  /** GPU renderer string (UNMASKED_RENDERER_WEBGL) for honest perf reports. */
  hardware: string;
}

/** Player spawn: south side, clear sightline to the arena centre (the SE
 *  pillar at (6,6) must not block the first thing the player ever sees). */
export const PLAYER_SPAWN = { x: 2.5, y: 0.9, z: 9.5, yaw: 0.26 } as const;

export function createGameState(): GameState {
  return {
    ready: false,
    level: { staticColliders: [], dynamicBoxes: [] },
    crates: null,
    weapon: {
      slot: 0,
      slots: [], // filled from configs by the WeaponSystem
      reloading: false,
      reloadEndsAt: 0,
      switchingUntil: 0,
      ads: 0,
      recoilPitch: 0,
      recoilYaw: 0,
      flashTtl: 0,
      lastShotAt: 0,
      adsFov: 55,
      scoped: false,
    },
    health: { hp: 100, dead: false, lastDamageAt: -Infinity },
    score: {
      kills: 0, wave: 0, catsAlive: 0,
      score: 0, combo: 1, comboEndsAt: 0, shots: 0, hits: 0, best: 0,
    },
    cats: [],
    colliderToEnemy: new Map(),
    enemySpawnQueue: [],
    enemyRemoveQueue: [],
    debugFreezeCats: false,
    player: {
      prevX: PLAYER_SPAWN.x, prevY: PLAYER_SPAWN.y, prevZ: PLAYER_SPAWN.z,
      currX: PLAYER_SPAWN.x, currY: PLAYER_SPAWN.y, currZ: PLAYER_SPAWN.z,
      yaw: PLAYER_SPAWN.yaw,
      pitch: 0,
      grounded: false,
      crouching: false,
      sprinting: false,
      speed2D: 0,
      landingImpact: 0,
      eyeOffset: 0.72,
      bobX: 0,
      bobY: 0,
      punchPitch: 0,
      lookDeltaX: 0,
      lookDeltaY: 0,
    },
    playerIntent: { wishX: 0, wishZ: 0, jump: false, crouch: false, sprint: false },
    playerTeleport: null,
    tuning: defaultTuning(),
    cameraMode: 'player',
    quality: { tier: 0, auto: true },
    perf: { frameMs: 0, drawCalls: 0, triangles: 0, heapMB: -1 },
    hardware: 'unknown',
  };
}
