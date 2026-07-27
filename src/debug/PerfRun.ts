import type { GameState } from '../core/GameState';
import type { CameraPoser, CrateResetter } from '../core/Capabilities';
import { heapMB } from './StatsOverlay';

export interface PerfResult {
  frames: number;
  warmupFrames: number;
  avgMs: number;
  p95Ms: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  heapStartMB: number;
  heapEndMB: number;
  heapGrowthMB: number;
}

const WARMUP = 60;
const HEAP_EVERY = 30;

/** Deterministic camera orbit + crate re-drops, recording per-frame timings.
 *  Driven by the render loop; results land on the debug API for the perf
 *  script to collect. Stats math allocates only at finish (off hot path). */
export class PerfRun {
  private active = false;
  private frame = 0;
  private target = 0;
  private frameMsBuf = new Float32Array(0);
  private heapSamples: number[] = [];
  private maxDraws = 0;
  private maxTris = 0;
  result: PerfResult | null = null;

  constructor(
    private readonly camera: CameraPoser,
    private readonly crates: CrateResetter,
  ) {}

  start(target = 600): void {
    this.target = target;
    this.frame = 0;
    this.frameMsBuf = new Float32Array(target);
    this.heapSamples = [];
    this.maxDraws = 0;
    this.maxTris = 0;
    this.result = null;
    this.active = true;
    this.crates.resetCrates();
  }

  /** Position the camera for this frame of the run (gameplay-like motion:
   *  orbit strafe around the arena centre with a subtle head bob). */
  beforeRender(): void {
    if (!this.active) return;
    const i = this.frame;
    const angle = i * 0.008;
    const radius = 8.5 - Math.sin(i * 0.004) * 2.0;
    const px = Math.sin(angle) * radius;
    const pz = Math.cos(angle) * radius;
    const py = 1.7 + Math.sin(i * 0.11) * 0.06;
    this.camera.setCameraPose(px, py, pz, Math.sin(angle + 0.9) * 2, 1.1, Math.cos(angle + 0.9) * 2);
    if (i === Math.floor(this.target / 2)) this.crates.resetCrates();
  }

  afterRender(state: GameState, frameMs: number): void {
    if (!this.active) return;
    if (this.frame < this.frameMsBuf.length) this.frameMsBuf[this.frame] = frameMs;
    if (state.perf.drawCalls > this.maxDraws) this.maxDraws = state.perf.drawCalls;
    if (state.perf.triangles > this.maxTris) this.maxTris = state.perf.triangles;
    if (this.frame % HEAP_EVERY === 0) this.heapSamples.push(heapMB());
    this.frame++;
    if (this.frame >= this.target) this.finish();
  }

  private finish(): void {
    this.active = false;
    const measured = Array.from(this.frameMsBuf.subarray(WARMUP));
    measured.sort((a, b) => a - b);
    const avg = measured.reduce((s, v) => s + v, 0) / Math.max(1, measured.length);
    const p95 = measured[Math.min(measured.length - 1, Math.floor(measured.length * 0.95))] ?? 0;
    const worst = measured[measured.length - 1] ?? 0;

    // Heap: compare medians of the first and last three post-warmup samples
    // (GC sawtooth makes single readings meaningless).
    const postWarmup = this.heapSamples.slice(Math.max(1, Math.floor(WARMUP / HEAP_EVERY)));
    const head = median(postWarmup.slice(0, 3));
    const tail = median(postWarmup.slice(-3));

    this.result = {
      frames: this.target,
      warmupFrames: WARMUP,
      avgMs: round2(avg),
      p95Ms: round2(p95),
      worstMs: round2(worst),
      drawCalls: this.maxDraws,
      triangles: this.maxTris,
      heapStartMB: round2(head),
      heapEndMB: round2(tail),
      heapGrowthMB: round2(tail - head),
    };
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return -1;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? -1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
