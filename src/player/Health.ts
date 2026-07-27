import { FIXED_DT } from '../core/Time';
import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';

const MAX_HP = 100;
const REGEN_DELAY_S = 5;
const REGEN_PER_S = 30;

/** Player health: damage in via bus, regen after 5 quiet seconds, death
 *  announced once. Restart resets everything. */
export class Health {
  private stateRef: GameState | null = null;

  constructor() {
    bus.on('player:damaged', ({ amount }) => {
      const h = this.stateRef?.health;
      if (!h || h.dead) return;
      h.hp = Math.max(0, h.hp - amount);
      h.lastDamageAt = performance.now() / 1000;
      if (h.hp <= 0) {
        h.dead = true;
        bus.emit('player:died', {});
      }
    });
    bus.on('game:restart', () => {
      const h = this.stateRef?.health;
      if (!h) return;
      h.hp = MAX_HP;
      h.dead = false;
      h.lastDamageAt = -Infinity;
    });
  }

  fixedStep(state: GameState): void {
    this.stateRef = state;
    const h = state.health;
    if (h.dead || h.hp >= MAX_HP) return;
    const now = performance.now() / 1000;
    if (now - h.lastDamageAt >= REGEN_DELAY_S) {
      h.hp = Math.min(MAX_HP, h.hp + REGEN_PER_S * FIXED_DT);
    }
  }
}
