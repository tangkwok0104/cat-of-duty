import type { GameState, QualityTier } from '../core/GameState';
import type { CameraPoser, CrateResetter, QualityControl } from '../core/Capabilities';
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

export function installDebugApi(
  state: GameState,
  camera: CameraPoser,
  crates: CrateResetter,
  quality: QualityControl,
  perfRun: PerfRun,
  input: Input,
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
