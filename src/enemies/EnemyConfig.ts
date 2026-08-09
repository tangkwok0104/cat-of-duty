import type { CatArchetype } from '../core/GameState';

/** Data-driven enemy archetypes (same declarative pattern as
 *  weapons/WeaponConfig.ts — typed TS data, compiler-guarded). */

export interface RangedSpec {
  /** The gunner tries to hold this distance from the player (m). */
  preferredRange: number;
  /** Max distance it will start a windup from (m). */
  fireRange: number;
  /** Telegraph seconds before the first shot — eyes flare, chirp plays.
   *  This is the fairness window: the player can always see it coming. */
  windup: number;
  /** Seconds between windups. */
  cooldown: number;
  /** Projectiles per trigger. */
  burst: number;
  /** Seconds between shots inside a burst. */
  burstInterval: number;
  /** m/s — deliberately slow enough to sidestep at preferred range
   *  (~0.5s travel at 7m vs a 0.2s sidestep). Dodgeable is fun; hitscan
   *  from an AI is a cheap death. */
  projectileSpeed: number;
  damage: number;
  /** Per-shot cone spread (radians). */
  spread: number;
}

export interface EnemyArchetype {
  id: CatArchetype;
  /** Killfeed / HUD display name. */
  name: string;
  hp: number;
  speedMin: number;
  speedMax: number;
  /** Uniform visual + hitbox scale (1 = base cat). */
  scale: number;
  /** Score multiplier per kill (base 100/kill). */
  scoreMult: number;
  meleeRange: number;
  meleeDamage: number;
  meleeCooldown: number;
  /** null = melee-only. */
  ranged: RangedSpec | null;
  /** Strafes side-to-side while holding range. */
  strafes: boolean;
  // Visual palette (CatVisual reads these).
  furColor: number;
  vestColor: number;
  eyeColor: number;
}

export const ARCHETYPES: Record<CatArchetype, EnemyArchetype> = {
  rusher: {
    id: 'rusher',
    name: 'RUSHER',
    hp: 100,
    speedMin: 2.4,
    speedMax: 3.2,
    scale: 1,
    scoreMult: 1,
    meleeRange: 1.25,
    meleeDamage: 10,
    meleeCooldown: 1.0,
    ranged: null,
    strafes: false,
    furColor: 0x8a8378,
    vestColor: 0x4a5136,
    eyeColor: 0x9dff57,
  },
  gunner: {
    id: 'gunner',
    name: 'GUNNER',
    hp: 80,
    speedMin: 1.6,
    speedMax: 2.0,
    scale: 1,
    scoreMult: 1.5,
    meleeRange: 1.25,
    meleeDamage: 8,
    meleeCooldown: 1.2,
    ranged: {
      preferredRange: 7,
      fireRange: 15,
      windup: 0.45,
      cooldown: 1.8,
      burst: 3,
      burstInterval: 0.12,
      projectileSpeed: 14,
      damage: 6,
      spread: 0.035,
    },
    strafes: true,
    furColor: 0x6e5b4a,
    vestColor: 0x5a2528,
    eyeColor: 0xffb13d,
  },
  heavy: {
    id: 'heavy',
    name: 'HEAVY',
    hp: 260,
    speedMin: 1.05,
    speedMax: 1.3,
    scale: 1.35,
    scoreMult: 2,
    meleeRange: 1.7,
    meleeDamage: 25,
    meleeCooldown: 1.4,
    ranged: null,
    strafes: false,
    furColor: 0x3b3b40,
    vestColor: 0x2e3a44,
    eyeColor: 0xff4d3d,
  },
};

/** Deterministic wave composition — no random mixing, so the harness (and
 *  the player) can learn the ramp. Waves 1–2 are pure base rushers: the
 *  loop-integrity harness's aimed-shot math (100hp, scale 1) stays valid.
 *  Gunners enter at 3, the first heavy at 5. Past 6 the mix grows but the
 *  field cap stays at 8 (perf budget: ≤7 meshes/cat, draws < 150).
 *
 *  Wave-8 heavy-drop rule: every 5th wave (wave % 5 === 0) adds +2 heavies
 *  beyond the formula below, still respecting MAX_FIELD_CATS. Waves 1 and 2
 *  are hardcoded pure-rusher returns with NO bonus applied — 1 % 5 !== 0 and
 *  2 % 5 !== 0 so the rule can never reach them mathematically, but they're
 *  also written to skip the bonus helper entirely so nothing here can ever
 *  perturb the harness's frozen aim-math waves. */
export const MAX_FIELD_CATS = 8;

/** Appends N extra heavies to a hardcoded (pre-cap) composition array, then
 *  re-applies the field cap. Only wave 5's literal composition is both
 *  hardcoded AND a multiple of 5, so this is only ever called from case 5
 *  below — the 7+ formula folds the bonus straight into its own heavy
 *  count instead (see default branch) so the rusher-count math makes room
 *  for it correctly rather than appending past the cap. */
function withBonusHeavies(mix: CatArchetype[], bonus: number): CatArchetype[] {
  if (bonus <= 0) return mix;
  const withExtra = [...mix];
  for (let i = 0; i < bonus; i++) withExtra.push('heavy');
  return withExtra.slice(0, MAX_FIELD_CATS);
}

export function waveComposition(wave: number): CatArchetype[] {
  const bonusHeavies = wave % 5 === 0 ? 2 : 0; // heavy-drop wave
  switch (wave) {
    case 1: return ['rusher']; // frozen: harness aim-math contract, no bonus logic touches this
    case 2: return ['rusher', 'rusher', 'rusher']; // frozen: harness aim-math contract, no bonus logic touches this
    case 3: return ['rusher', 'rusher', 'gunner'];
    case 4: return ['rusher', 'rusher', 'gunner', 'gunner'];
    case 5: return withBonusHeavies(['rusher', 'rusher', 'gunner', 'gunner', 'heavy'], bonusHeavies);
    case 6: return ['rusher', 'rusher', 'rusher', 'gunner', 'gunner', 'heavy'];
    default: {
      // 7+: pressure scales by swapping rushers for specialists.
      const gunners = Math.min(3, 2 + Math.floor((wave - 6) / 2));
      let heavies = Math.min(2, 1 + Math.floor((wave - 5) / 3));
      let rushers = Math.max(2, MAX_FIELD_CATS - gunners - heavies);
      if (bonusHeavies > 0) {
        // Heavy-drop wave: convert rusher slots into heavies instead of
        // appending past the cap. At this point gunners/heavies are both
        // already formula-saturated (their Math.min ceilings), so summing
        // them with the base rusher count sits exactly at MAX_FIELD_CATS —
        // appending 2 more heavies on top would overflow by 2 and the
        // trailing slice() below would silently eat the bonus (verified:
        // wave 10/15/20/25 all landed only +1 heavy, not +2, before this
        // fix). Converting keeps the total fixed at the cap and guarantees
        // the full bonus lands as long as enough rushers exist to convert.
        const converted = Math.min(bonusHeavies, rushers);
        rushers -= converted;
        heavies += converted;
      }
      const mix: CatArchetype[] = [];
      for (let i = 0; i < rushers; i++) mix.push('rusher');
      for (let i = 0; i < gunners; i++) mix.push('gunner');
      for (let i = 0; i < heavies; i++) mix.push('heavy');
      return mix.slice(0, MAX_FIELD_CATS);
    }
  }
}
