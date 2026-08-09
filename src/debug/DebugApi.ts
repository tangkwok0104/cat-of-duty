import type { GameState, QualityTier } from '../core/GameState';
import type {
  CameraPoser,
  CrateResetter,
  QualityControl,
  HitscanCaster,
  BulletHit,
} from '../core/Capabilities';
import type { Input } from '../core/Input';
import type { PerfRun, PerfResult } from './PerfRun';
import { heapMB } from './StatsOverlay';

/** Automation surface for capture/perf/latency scripts (and manual console
 *  poking). Depends only on core types + capability interfaces. */
export interface CodApi {
  version: string;
  readonly ready: boolean;
  /** Detach the camera from the player and pose it (screenshots). */
  setCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void;
  /** Teleport the player and re-attach the camera to the player rig. */
  setPlayer(x: number, y: number, z: number, yaw: number, pitch: number): void;
  resetCrates(): void;
  setQuality(tier: QualityTier, auto: boolean): void;
  showBoot(show: boolean): void;
  startPerfRun(frames?: number): void;
  perfResult: PerfResult | null;
  /** Harness-only: let mousemove deltas through without real pointer lock. */
  forceInputCapture(on: boolean): void;
  /** Harness-only: freeze cat AI so aimed shots test guns, not tracking. */
  setCatsFrozen(on: boolean): void;
  /** Harness-only: own every weapon slot with full ammo, and clear the
   *  ground weapon pickups so no aimed step can trip an auto-switch.
   *  game:restart resets ownership — call again after a restart step. */
  grantAllWeapons(): void;
  /** Harness-only: would a bullet from (x,y,z) hit this cat first?
   *  Uses the real physics ray — walls/crates/pillars all count. */
  lineOfSightToCat(x: number, y: number, z: number, catId: number, aimY: number): boolean;
  getLatency(): { samples: number; p50: number; p95: number };
  getPerf(): {
    frameMs: number;
    drawCalls: number;
    triangles: number;
    heapMB: number;
    tier: number;
    hardware: string;
    player: { x: number; y: number; z: number; grounded: boolean; crouching: boolean; speed2D: number };
  };
  /** Full gameplay state snapshot for loop-integrity assertions. */
  getGame(): {
    hp: number;
    dead: boolean;
    slot: number;
    ammo: number;
    reserve: number;
    reloading: boolean;
    kills: number;
    wave: number;
    catsAlive: number;
    cats: { id: number; x: number; y: number; z: number; hp: number; phase: string }[];
  };
}

declare global {
  interface Window {
    __cod: CodApi;
  }
}

const _losHit: BulletHit = { hit: false, collider: -1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };

/** Arsenal hooks main wires in (WeaponSystem grant + pickup clearing) —
 *  kept as a narrow interface so this file stays off the weapons folder. */
export interface ArsenalDebug {
  grantAllWeapons(): void;
}

export function installDebugApi(
  state: GameState,
  camera: CameraPoser,
  crates: CrateResetter,
  quality: QualityControl,
  perfRun: PerfRun,
  input: Input,
  caster: HitscanCaster,
  arsenal: ArsenalDebug,
): CodApi {
  const api: CodApi = {
    version: '0.1.0',
    get ready() {
      return state.ready;
    },
    setCamera: (px, py, pz, tx, ty, tz) => {
      state.cameraMode = 'debug';
      camera.setCameraPose(px, py, pz, tx, ty, tz);
    },
    setPlayer: (x, y, z, yaw, pitch) => {
      state.cameraMode = 'player';
      state.playerTeleport = { x, y, z, yaw, pitch };
    },
    resetCrates: () => crates.resetCrates(),
    setQuality: (tier, auto) => quality.setTier(tier, auto),
    showBoot: (show) => {
      document.getElementById('boot-screen')?.classList.toggle('hidden', !show);
      if (show && state.ready) {
        const status = document.getElementById('boot-status');
        if (status) status.textContent = 'SYSTEMS READY';
      }
    },
    startPerfRun: (frames = 600) => {
      state.cameraMode = 'debug';
      perfRun.start(frames);
    },
    get perfResult() {
      return perfRun.result;
    },
    forceInputCapture: (on) => {
      input.captureOverride = on;
    },
    setCatsFrozen: (on) => {
      state.debugFreezeCats = on;
    },
    grantAllWeapons: () => arsenal.grantAllWeapons(),
    lineOfSightToCat: (x, y, z, catId, aimY) => {
      const cat = state.cats.find((c) => c.id === catId && c.phase === 'alive');
      if (!cat) return false;
      const dx = cat.x - x;
      const dy = aimY - y;
      const dz = cat.z - z;
      const len = Math.hypot(dx, dy, dz) || 1;
      caster.castBullet(x, y, z, dx / len, dy / len, dz / len, 200, _losHit);
      if (!_losHit.hit) return false;
      const enemy = state.colliderToEnemy.get(_losHit.collider);
      return enemy?.id === catId;
    },
    getLatency: () => input.latencyStats(),
    getPerf: () => ({
      frameMs: state.perf.frameMs,
      drawCalls: state.perf.drawCalls,
      triangles: state.perf.triangles,
      heapMB: heapMB(),
      tier: state.quality.tier,
      hardware: state.hardware,
      player: {
        x: state.player.currX,
        y: state.player.currY,
        z: state.player.currZ,
        grounded: state.player.grounded,
        crouching: state.player.crouching,
        speed2D: state.player.speed2D,
      },
    }),
    getGame: () => ({
      hp: state.health.hp,
      dead: state.health.dead,
      slot: state.weapon.slot,
      ammo: state.weapon.slots[state.weapon.slot]?.ammo ?? 0,
      reserve: state.weapon.slots[state.weapon.slot]?.reserve ?? 0,
      reloading: state.weapon.reloading,
      kills: state.score.kills,
      wave: state.score.wave,
      catsAlive: state.score.catsAlive,
      cats: state.cats.map((c) => ({ id: c.id, x: c.x, y: c.y, z: c.z, hp: c.hp, phase: c.phase })),
    }),
  };
  window.__cod = api;
  return api;
}
