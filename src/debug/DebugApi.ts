import type { GameState, QualityTier } from '../core/GameState';
import type { RenderSystem } from '../render/RenderSystem';
import type { PhysicsSystem } from '../physics/PhysicsSystem';
import type { QualityManager } from '../render/QualityManager';
import type { PerfRun, PerfResult } from './PerfRun';
import { heapMB } from './StatsOverlay';

/** Automation surface for capture/perf scripts (and manual console poking).
 *  Everything the Playwright harness needs lives on window.__cod. */
export interface CodApi {
  version: string;
  ready: boolean;
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
  renderSys: RenderSystem,
  physics: PhysicsSystem,
  quality: QualityManager,
  perfRun: PerfRun,
): CodApi {
  const api: CodApi = {
    version: '0.0.1',
    ready: false,
    setCamera: (px, py, pz, tx, ty, tz) => renderSys.setCameraPose(px, py, pz, tx, ty, tz),
    resetCrates: () => physics.resetCrates(),
    setQuality: (tier, auto) => quality.setTier(tier, auto),
    showBoot: (show) => {
      document.getElementById('boot-screen')?.classList.toggle('hidden', !show);
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
