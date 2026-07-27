import type { GameState, QualityTier } from '../core/GameState';
import type { CameraPoser, CrateResetter, QualityControl } from '../core/Capabilities';
import type { PerfRun, PerfResult } from './PerfRun';
import { heapMB } from './StatsOverlay';

/** Automation surface for capture/perf scripts (and manual console poking).
 *  Everything the Playwright harness needs lives on window.__cod. Depends
 *  only on core capability interfaces — never on sibling system classes. */
export interface CodApi {
  version: string;
  readonly ready: boolean;
  setCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void;
  resetCrates(): void;
  setQuality(tier: QualityTier, auto: boolean): void;
  showBoot(show: boolean): void;
  startPerfRun(frames?: number): void;
  perfResult: PerfResult | null;
  getPerf(): {
    frameMs: number;
    drawCalls: number;
    triangles: number;
    heapMB: number;
    tier: number;
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
): CodApi {
  const api: CodApi = {
    version: '0.0.1',
    get ready() {
      return state.ready; // single source of truth — no duplicate flag
    },
    setCamera: (px, py, pz, tx, ty, tz) => camera.setCameraPose(px, py, pz, tx, ty, tz),
    resetCrates: () => crates.resetCrates(),
    setQuality: (tier, auto) => quality.setTier(tier, auto),
    showBoot: (show) => {
      document.getElementById('boot-screen')?.classList.toggle('hidden', !show);
      // Re-showing the boot surface after load must not claim to be loading.
      if (show && state.ready) {
        const status = document.getElementById('boot-status');
        if (status) status.textContent = 'SYSTEMS READY';
      }
    },
    startPerfRun: (frames = 600) => perfRun.start(frames),
    get perfResult() {
      return perfRun.result;
    },
    getPerf: () => ({
      frameMs: state.perf.frameMs,
      drawCalls: state.perf.drawCalls,
      triangles: state.perf.triangles,
      heapMB: heapMB(),
      tier: state.quality.tier,
    }),
  };
  window.__cod = api;
  return api;
}
