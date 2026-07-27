/** Input: pointer lock + raw mouse deltas + key states, with input-to-render
 *  latency instrumentation built in.
 *
 *  Responsiveness contract (non-negotiable, verified by /review §4):
 *  mouse deltas are accumulated raw and consumed once per rendered frame —
 *  NO smoothing, NO acceleration, NO interpolation anywhere in the path. */

const PENDING_CAP = 64;
const LATENCY_CAP = 1024;

export class Input {
  private keys = new Set<string>();
  private edges = new Set<string>();
  private buttons = new Set<number>();
  private keyDownHandlers = new Map<string, () => void>();

  private deltaX = 0;
  private deltaY = 0;
  locked = false;
  /** Harness-only escape hatch: accept mousemove deltas without real pointer
   *  lock (headless environments can't always acquire it). Never set by game
   *  code — only by the debug API. */
  captureOverride = false;

  // Latency instrumentation: event timestamps waiting to be reflected in a
  // frame, and the samples produced when that frame finishes rendering.
  private pendingTs = new Float64Array(PENDING_CAP);
  private pendingCount = 0;
  private appliedTs = new Float64Array(PENDING_CAP);
  private appliedCount = 0;
  private latency = new Float64Array(LATENCY_CAP);
  private latencyCount = 0;
  private latencyCursor = 0;

  private readonly lockTargetEl: HTMLElement;

  constructor(lockTarget: HTMLElement) {
    this.lockTargetEl = lockTarget;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.edges.add(e.code);
      this.keyDownHandlers.get(e.code)?.();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons.clear();
    });
    window.addEventListener('mousedown', (e) => {
      if (this.locked || this.captureOverride) this.buttons.add(e.button);
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons.delete(e.button);
    });

    lockTarget.addEventListener('click', () => {
      if (this.locked) return;
      // requestPointerLock returns a promise that REJECTS when the browser
      // denies it (e.g. clicking during the post-ESC cooldown, or headless).
      // Denial is not an error state: the prompt stays up and the next click
      // tries again — but the rejection must be consumed or it lands in the
      // console as an unhandled error.
      const req = lockTarget.requestPointerLock() as Promise<void> | undefined;
      req?.catch(() => {});
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === lockTarget;
      if (!this.locked) this.keys.clear();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked && !this.captureOverride) return;
      this.deltaX += e.movementX;
      this.deltaY += e.movementY;
      if (this.pendingCount < PENDING_CAP) {
        this.pendingTs[this.pendingCount++] = performance.now();
      }
    });
  }

  /** Debug/back-compat: fire a callback on key press. */
  onKeyDown(code: string, fn: () => void): void {
    this.keyDownHandlers.set(code, fn);
  }

  /** UI-initiated lock request (menu DEPLOY button). */
  requestLock(): void {
    if (this.locked) return;
    const req = this.lockTargetEl.requestPointerLock() as Promise<void> | undefined;
    req?.catch(() => {});
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Mouse button held? 0 = fire, 2 = ADS. */
  isButtonDown(button: number): boolean {
    return this.buttons.has(button);
  }

  /** True if the key was pressed since the last clearEdges(). */
  wasPressed(code: string): boolean {
    return this.edges.has(code);
  }

  clearEdges(): void {
    this.edges.clear();
  }

  /** Consume the accumulated raw mouse delta (called once per rendered
   *  frame). Pending latency timestamps move to the applied stash. */
  consumeMouseDelta(out: { dx: number; dy: number }): void {
    out.dx = this.deltaX;
    out.dy = this.deltaY;
    this.deltaX = 0;
    this.deltaY = 0;
    for (let i = 0; i < this.pendingCount; i++) {
      this.appliedTs[i] = this.pendingTs[i] ?? 0;
    }
    this.appliedCount = this.pendingCount;
    this.pendingCount = 0;
  }

  /** Call after the frame that consumed the deltas finished rendering —
   *  closes the input→render measurement for every applied event. */
  completeFrame(now: number): void {
    for (let i = 0; i < this.appliedCount; i++) {
      this.latency[this.latencyCursor] = now - (this.appliedTs[i] ?? now);
      this.latencyCursor = (this.latencyCursor + 1) % LATENCY_CAP;
      if (this.latencyCount < LATENCY_CAP) this.latencyCount++;
    }
    this.appliedCount = 0;
  }

  latencyStats(): { samples: number; p50: number; p95: number } {
    const n = this.latencyCount;
    if (n === 0) return { samples: 0, p50: -1, p95: -1 };
    const sorted = Array.from(this.latency.subarray(0, n)).sort((a, b) => a - b);
    const pick = (q: number): number =>
      sorted[Math.min(n - 1, Math.floor(n * q))] ?? -1;
    return {
      samples: n,
      p50: Math.round(pick(0.5) * 100) / 100,
      p95: Math.round(pick(0.95) * 100) / 100,
    };
  }
}
