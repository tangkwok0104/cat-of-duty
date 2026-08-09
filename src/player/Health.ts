import { FIXED_DT } from '../core/Time';
import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';

/** Base max HP before the NINE LIVES upgrade (wave-8). Exported as the
 *  single source of truth: Upgrades.ts imports `effectiveMaxHp`/
 *  `HP_PER_LIVES_LEVEL` rather than re-deriving the formula, so the two
 *  files can't drift. Zero purchases → livesLvl 0 → effectiveMaxHp ===
 *  MAX_HP exactly, so an untouched run is bit-identical to pre-wave-8. */
export const MAX_HP = 100;
/** NINE LIVES: +25 max hp per level. */
export const HP_PER_LIVES_LEVEL = 25;
const REGEN_DELAY_S = 5;
const REGEN_PER_S = 30;

/** Current max hp including any purchased NINE LIVES levels. */
export function effectiveMaxHp(state: GameState): number {
  return MAX_HP + HP_PER_LIVES_LEVEL * state.upgrades.livesLvl;
}

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
      // Upgrades resets livesLvl to 0 on this same event, so the effective
      // max after a restart is always exactly MAX_HP — reset to the base
      // constant directly rather than effectiveMaxHp() so this doesn't
      // depend on the two restart handlers' registration order.
      h.hp = MAX_HP;
      h.dead = false;
      h.lastDamageAt = -Infinity;
    });
  }

  fixedStep(state: GameState): void {
    this.stateRef = state;
    const h = state.health;
    const max = effectiveMaxHp(state);
    if (h.dead || h.hp >= max) return;
    const now = performance.now() / 1000;
    if (now - h.lastDamageAt >= REGEN_DELAY_S) {
      h.hp = Math.min(max, h.hp + REGEN_PER_S * FIXED_DT);
    }
  }
}
