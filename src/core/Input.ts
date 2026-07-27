/** M0 input is debug-only: Q cycles the quality tier. Pointer-lock look and
 *  WASD arrive with the M1 player controller. */
export class Input {
  private keyDownHandlers = new Map<string, () => void>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keyDownHandlers.get(e.code)?.();
    });
  }

  onKeyDown(code: string, fn: () => void): void {
    this.keyDownHandlers.set(code, fn);
  }
}
