import type { WebGLRenderer } from 'three';
import type { GameState, QualityTier } from '../core/GameState';
import { bus } from '../core/EventBus';
import { basePixelRatio } from './Renderer';
import type { Lighting } from './Lighting';
import type { PostFX } from './PostFX';

interface TierSpec {
  name: string;
  shadowMapSize: number;
  ao: boolean;
  bloom: boolean;
  renderScale: number;
}

/** Step-down order per spec: shadow resolution → SSAO → bloom → render scale. */
const TIERS: readonly TierSpec[] = [
  { name: 'ULTRA', shadowMapSize: 2048, ao: true, bloom: true, renderScale: 1.0 },
  { name: 'HIGH', shadowMapSize: 1024, ao: true, bloom: true, renderScale: 1.0 },
  { name: 'MED', shadowMapSize: 1024, ao: false, bloom: true, renderScale: 0.85 },
  { name: 'LOW', shadowMapSize: 512, ao: false, bloom: false, renderScale: 0.7 },
];

const WINDOW_MS = 3000; // frame-time observation window
const STEP_DOWN_AVG_MS = 17.5; // sustained miss of 60fps → degrade
const COOLDOWN_MS = 4000; // let the change settle before judging again

/** Watches real frame times and walks down the quality ladder when the
 *  machine can't hold 60fps. Never walks back up on its own — a mid-fight
 *  quality oscillation is worse than staying conservative. Manual override
 *  via debug API / Q key sets auto=false. */
export class QualityManager {
  private windowStart = performance.now();
  private frameCount = 0;
  private frameMsSum = 0;
  private lastChange = 0;

  constructor(
    private readonly state: GameState,
    private readonly renderer: WebGLRenderer,
    private readonly lighting: Lighting,
    private readonly postfx: PostFX,
  ) {
    this.apply(state.quality.tier, 'manual');
  }

  tierName(): string {
    return TIERS[this.state.quality.tier]?.name ?? '?';
  }

  setTier(tier: QualityTier, auto: boolean): void {
    this.state.quality.auto = auto;
    this.apply(tier, 'manual');
  }

  /** Called once per rendered frame. */
  observe(frameMs: number, now: number): void {
    this.frameCount++;
    this.frameMsSum += frameMs;
    if (now - this.windowStart < WINDOW_MS) return;

    const avg = this.frameMsSum / Math.max(1, this.frameCount);
    this.windowStart = now;
    this.frameCount = 0;
    this.frameMsSum = 0;

    if (!this.state.quality.auto) return;
    if (now - this.lastChange < COOLDOWN_MS) return;
    if (avg > STEP_DOWN_AVG_MS && this.state.quality.tier < TIERS.length - 1) {
      this.apply((this.state.quality.tier + 1) as QualityTier, 'adaptive');
      this.lastChange = now;
    }
  }

  private apply(tier: QualityTier, reason: 'manual' | 'adaptive'): void {
    const spec = TIERS[tier];
    if (!spec) return;
    this.state.quality.tier = tier;
    this.lighting.setShadowMapSize(spec.shadowMapSize);
    this.postfx.setAOEnabled(spec.ao);
    this.postfx.setBloomEnabled(spec.bloom);
    this.renderer.setPixelRatio(basePixelRatio() * spec.renderScale);
    this.postfx.onResize(window.innerWidth, window.innerHeight);
    bus.emit('quality:changed', { tier, reason });
  }
}
