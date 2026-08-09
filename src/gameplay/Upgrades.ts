import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';
import { WEAPONS, type WeaponConfig } from '../weapons/WeaponConfig';
import { HP_PER_LIVES_LEVEL, effectiveMaxHp } from '../player/Health';

/** Field-promotion economy (wave-8): spend TUNA (earned on kills — see
 *  CatSystem.kill()) during the wave intermission on three permanent
 *  upgrades. Everything resets on 'game:restart'. Zero purchases must leave
 *  every number in the game bit-identical to pre-wave-8 (the loop harness
 *  asserts exact damage/ammo/hp and never buys) — every grant below is
 *  purchase-gated, so an untouched run never executes them. */

type UpgradeId = 'claws' | 'pockets' | 'lives';

const MAX_LEVEL = 3;

/** Per-level cost to REACH that level (index 0 = cost of level 1). */
const COSTS: Readonly<Record<UpgradeId, readonly [number, number, number]>> = {
  claws: [50, 75, 100],
  pockets: [40, 60, 80],
  lives: [60, 90, 120],
};

/** DEEP POCKETS reserve-cap helper. The duplicate-pickup/station top-up caps
 *  (WeaponPickups.ts, not this wave's file) clamp at `cfg.reserveStart` —
 *  this is the extended cap those call sites should clamp to instead, once
 *  wired up by the integrator (see PROGRESS/concerns: WeaponPickups.ts is
 *  owned by a different slice this wave). */
export function reserveCap(cfg: Pick<WeaponConfig, 'mag' | 'reserveStart'>, state: GameState): number {
  return cfg.reserveStart + state.upgrades.pocketsLvl * cfg.mag;
}

export class Upgrades {
  private readonly state: GameState;
  /** True strictly between a 'wave:cleared' and the next 'wave:started' —
   *  starts false so pre-game (before the first wave) is CLOSED too. */
  private intermissionOpen = false;

  constructor(state: GameState) {
    this.state = state;

    bus.on('wave:cleared', () => {
      this.intermissionOpen = true;
    });
    bus.on('wave:started', () => {
      this.intermissionOpen = false;
    });
    bus.on('game:restart', () => this.reset());

    // Z/X/C purchase hotkeys. Always-on window listener (matches this
    // codebase's idiom for standalone keydown actions — see main.ts's
    // KeyQ/KeyT/F1/KeyR handlers, none of which gate on pointer lock); the
    // intermission-open check below is the real guard, exactly as the
    // wave-8 contract allows. e.repeat is ignored so holding a key down
    // can't fire a purchase per frame.
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      switch (e.code) {
        case 'KeyZ':
          this.purchase('claws');
          break;
        case 'KeyX':
          this.purchase('pockets');
          break;
        case 'KeyV': // NOT KeyC — crouch reads C (PlayerController); QA caught the double-bind
          this.purchase('lives');
          break;
      }
    });
  }

  private levelOf(id: UpgradeId): number {
    const u = this.state.upgrades;
    if (id === 'claws') return u.clawsLvl;
    if (id === 'pockets') return u.pocketsLvl;
    return u.livesLvl;
  }

  private setLevel(id: UpgradeId, level: number): void {
    const u = this.state.upgrades;
    if (id === 'claws') u.clawsLvl = level;
    else if (id === 'pockets') u.pocketsLvl = level;
    else u.livesLvl = level;
  }

  private purchase(id: UpgradeId): void {
    if (!this.intermissionOpen) {
      bus.emit('upgrade:denied', { id, reason: 'closed' });
      return;
    }
    const level = this.levelOf(id);
    if (level >= MAX_LEVEL) {
      bus.emit('upgrade:denied', { id, reason: 'maxed' });
      return;
    }
    const cost = COSTS[id][level];
    if (cost === undefined) return; // unreachable — level < MAX_LEVEL is guarded above
    const u = this.state.upgrades;
    if (u.tuna < cost) {
      bus.emit('upgrade:denied', { id, reason: 'tuna' });
      return;
    }

    u.tuna -= cost;
    const newLevel = level + 1;
    this.setLevel(id, newLevel);
    this.applyGrant(id);
    bus.emit('upgrade:purchased', { id, level: newLevel, cost });
  }

  /** Instant purchase-time effects. 'claws' has none — its damage
   *  multiplier is read live by WeaponSystem every shot. */
  private applyGrant(id: UpgradeId): void {
    const state = this.state;
    if (id === 'pockets') {
      // +1 mag of reserve to EVERY owned gun, capped by the new cap.
      for (let i = 0; i < WEAPONS.length; i++) {
        if (!state.weapon.owned[i]) continue;
        const cfg = WEAPONS[i];
        const slot = state.weapon.slots[i];
        if (!cfg || !slot) continue;
        slot.reserve = Math.min(reserveCap(cfg, state), slot.reserve + cfg.mag);
      }
    } else if (id === 'lives') {
      // livesLvl was already bumped by setLevel() above, so effectiveMaxHp
      // already reflects the new level.
      state.health.hp = Math.min(effectiveMaxHp(state), state.health.hp + HP_PER_LIVES_LEVEL);
    }
  }

  private reset(): void {
    const u = this.state.upgrades;
    u.tuna = 0;
    u.clawsLvl = 0;
    u.pocketsLvl = 0;
    u.livesLvl = 0;
    this.intermissionOpen = false;
  }
}
