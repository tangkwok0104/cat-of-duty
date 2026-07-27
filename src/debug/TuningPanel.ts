import { Pane } from 'tweakpane';
import type { GameState } from '../core/GameState';

/** Live feel-tuning panel (F1). Binds straight onto GameState.tuning — the
 *  controller and camera read those values every tick, so changes apply
 *  instantly. This is what turns "feels bad" into "feels right" in one
 *  sitting instead of ten agent round-trips. */
export class TuningPanel {
  private pane: Pane;

  constructor(state: GameState) {
    this.pane = new Pane({ title: 'FEEL TUNING (F1)' });
    const t = state.tuning;

    const look = this.pane.addFolder({ title: 'Look' });
    look.addBinding(t, 'sensitivity', { min: 0.0005, max: 0.006, step: 0.0001 });
    look.addBinding(t, 'baseFov', { min: 60, max: 110, step: 1 });

    const move = this.pane.addFolder({ title: 'Movement' });
    move.addBinding(t, 'walkSpeed', { min: 2, max: 10, step: 0.1 });
    move.addBinding(t, 'sprintMult', { min: 1, max: 2.5, step: 0.05 });
    move.addBinding(t, 'crouchMult', { min: 0.2, max: 1, step: 0.05 });
    move.addBinding(t, 'groundAccel', { min: 10, max: 150, step: 5 });
    move.addBinding(t, 'airAccel', { min: 0, max: 60, step: 1 });
    move.addBinding(t, 'stopDecel', { min: 10, max: 200, step: 5 });

    const jump = this.pane.addFolder({ title: 'Jump' });
    jump.addBinding(t, 'jumpVel', { min: 3, max: 12, step: 0.1 });
    jump.addBinding(t, 'gravity', { min: -40, max: -10, step: 0.5 });
    jump.addBinding(t, 'coyoteMs', { min: 0, max: 300, step: 10 });
    jump.addBinding(t, 'jumpBufferMs', { min: 0, max: 300, step: 10 });

    const feel = this.pane.addFolder({ title: 'Camera feel' });
    feel.addBinding(t, 'bobAmp', { min: 0, max: 0.1, step: 0.002 });
    feel.addBinding(t, 'bobFreq', { min: 0.5, max: 4, step: 0.1 });
    feel.addBinding(t, 'punchScale', { min: 0, max: 0.1, step: 0.002 });

    this.pane.hidden = true;
  }

  toggle(): void {
    this.pane.hidden = !this.pane.hidden;
  }
}
