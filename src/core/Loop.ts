import { FIXED_DT, MAX_CATCHUP_STEPS, MAX_FRAME_MS } from './Time';
import type { GameState } from './GameState';

export interface FixedStepSystem {
  fixedStep(state: GameState): void;
}

export interface RenderFn {
  (alpha: number, frameMs: number): void;
}

/** The engine heartbeat. Physics advances in exact FIXED_DT steps; the
 *  renderer receives alpha ∈ [0,1) — how far we are between the last two
 *  physics states — and interpolates. Hot path allocates nothing. */
export class Loop {
  private accumulator = 0;
  private lastNow = 0;
  private rafId = 0;
  private running = false;

  constructor(
    private readonly state: GameState,
    /** Run in order every fixed step (player intent BEFORE physics). */
    private readonly fixedSystems: readonly FixedStepSystem[],
    private readonly render: RenderFn,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    const tick = (now: number): void => {
      if (!this.running) return;
      let frameMs = now - this.lastNow;
      this.lastNow = now;
      if (frameMs > MAX_FRAME_MS) frameMs = MAX_FRAME_MS;
      if (frameMs < 0) frameMs = 0;

      // Hit-stop: the world holds its breath for ~40ms on a kill while
      // rendering (and the camera) stay live. Time inside the stop is
      // DROPPED, not accumulated — otherwise physics would sprint to catch
      // up afterwards and undo the effect.
      if (now < this.state.hitStopUntil) {
        this.accumulator = 0;
      } else {
        this.accumulator += frameMs / 1000;
      }
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_CATCHUP_STEPS) {
        for (const sys of this.fixedSystems) sys.fixedStep(this.state);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      // Hopelessly behind (tab hidden, giant hitch): drop the debt.
      if (steps === MAX_CATCHUP_STEPS && this.accumulator >= FIXED_DT) {
        this.accumulator = 0;
      }

      const alpha = this.accumulator / FIXED_DT;
      this.state.perf.frameMs = frameMs;
      this.render(alpha, frameMs);

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}
