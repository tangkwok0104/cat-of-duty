import type { Mesh, Scene } from 'three';
import { FIXED_DT } from '../core/Time';
import type { GameState, CatData } from '../core/GameState';
import { bus } from '../core/EventBus';
import { buildCatVisual, type CatVisual } from './CatVisual';
import { ARCHETYPES, waveComposition } from './EnemyConfig';
import { CatProjectiles, hasLineOfSight } from './CatProjectiles';

const SEPARATION_DIST = 0.9;
const DESPAWN_AFTER = 2.0; // s after death
// Playtest asked for a real breather (1.5s read as barely a pause). Spawns
// are already gated behind waveTimer, so nothing spawns mid-intermission.
const WAVE_BREATHER = 7.0; // s between waves
/** Seconds of claw-swipe animation per melee attack. Contract with
 *  CatVisual: it compresses the attack clip into this window so the strike
 *  reads right as the damage lands. */
const MELEE_ANIM_TIME = 0.6;
const OBSTACLE_MIN_TOP_Y = 0.5; // colliders shorter than this never push cats
const OBSTACLE_RADIUS = 0.35; // base cat push-out radius (scaled per cat)
const ARENA_CLAMP = 18.3;

/** Spawn ring: fixed points hugging the arena walls. */
const SPAWN_POINTS: readonly [number, number][] = [
  [-17, -17], [0, -17.5], [17, -17],
  [-17.5, 0], [17.5, 0],
  [-17, 17], [0, 17.5], [17, 17],
];

/** Cat AI: rushers/heavies walk straight at the player and claw on contact;
 *  gunners hold their preferred range, strafe, telegraph a windup (fair
 *  warning — the player can always see it coming), then burst-fire
 *  dodgeable projectiles. All cats push out of pillars/crates instead of
 *  clipping through them. Waves ramp via EnemyConfig.waveComposition, next
 *  wave when the field is clear. Owns visuals (scene handed in by the
 *  composition root) and AI; colliders are mirrored by the physics system
 *  via GameState queues. */
export class CatSystem {
  private visuals = new Map<number, CatVisual>();
  private readonly projectiles: CatProjectiles;
  private nextId = 1;
  private waveTimer = 0; // counts down the breather between waves
  private started = false;
  /** Guards the one-shot wave:cleared emit. Starts true (an empty pre-game
   *  field is not a cleared wave); spawnWave() arms it, the clear emit and
   *  restart() disarm it — so restart/death cleanup never fire the event. */
  private waveCleared = true;
  /** Highest streak tier already emitted for the current combo chain — gates
   *  score:streak to fire only on tier RISE, never per kill. */
  private lastStreakTier = 0;

  constructor(private readonly scene: Scene) {
    this.projectiles = new CatProjectiles(scene);
    bus.on('enemy:hit', ({ id, killed, part }) => {
      const state = this.stateRef;
      if (!state) return;
      const cat = state.cats.find((c) => c.id === id);
      if (!cat || cat.phase !== 'alive') return;
      cat.flinch = 0.15;
      if (killed) this.kill(state, cat, part === 'head');
    });
    bus.on('game:restart', () => this.restart());
  }

  private stateRef: GameState | null = null;

  /** Registered with PostFX the same way WeaponSystem's viewmodel is. */
  get bloomMeshes(): Mesh[] {
    return this.projectiles.bloomMeshes;
  }

  /** The slice starts its first wave once the player locks in. */
  startWaves(): void {
    this.started = true;
  }

  fixedStep(state: GameState): void {
    this.stateRef = state;
    const dt = FIXED_DT;
    const px = state.player.currX;
    const pz = state.player.currZ;
    const targetEyeY = state.player.currY + state.player.eyeOffset;

    // Wave logic: field clear → breather → next wave.
    if (this.started && !state.health.dead) {
      const anyAlive = state.cats.some((c) => c.phase === 'alive');
      if (!anyAlive) {
        if (!this.waveCleared) {
          // The field just went clear — fires once per wave, before the
          // breather countdown starts.
          this.waveCleared = true;
          bus.emit('wave:cleared', { wave: state.score.wave, breatherS: WAVE_BREATHER });
        }
        this.waveTimer -= dt;
        if (this.waveTimer <= 0) {
          state.score.wave++;
          const count = this.spawnWave(state, px, pz);
          this.waveCleared = false;
          this.waveTimer = WAVE_BREATHER;
          bus.emit('wave:started', {
            wave: state.score.wave,
            count,
            special: state.score.wave % 5 === 0,
          });
        }
      } else {
        this.waveTimer = WAVE_BREATHER;
      }
    }

    // Per-cat behaviour.
    for (const cat of state.cats) {
      if (cat.phase === 'dying') {
        cat.deadFor += dt;
        continue;
      }
      // Swipe-anim clock ticks even through flinch/freeze so the visual
      // never stalls mid-swing.
      if (cat.meleeAnim > 0) cat.meleeAnim = Math.max(0, cat.meleeAnim - dt);
      if (cat.flinch > 0) {
        cat.flinch -= dt;
        continue; // staggered — no move, no attack
      }
      if (state.debugFreezeCats) continue; // harness determinism

      const spec = ARCHETYPES[cat.archetype];
      const dx = px - cat.x;
      const dz = pz - cat.z;
      const dist = Math.hypot(dx, dz);
      cat.yaw = Math.atan2(-dx, -dz) + Math.PI; // face the player
      cat.attackCooldown = Math.max(0, cat.attackCooldown - dt);
      if (spec.ranged) cat.fireCooldown = Math.max(0, cat.fireCooldown - dt);

      if (dist <= spec.meleeRange) {
        if (cat.attackCooldown <= 0 && !state.health.dead) {
          cat.attackCooldown = spec.meleeCooldown;
          cat.meleeAnim = MELEE_ANIM_TIME;
          bus.emit('enemy:melee', { id: cat.id });
          bus.emit('player:damaged', { amount: spec.meleeDamage, fromX: cat.x, fromZ: cat.z });
        }
      } else if (!spec.ranged || dist > spec.ranged.fireRange) {
        // Seek + separation (no navmesh by design — slice spec). Straight-line
        // seek can wedge on a collider face (seek pushes in, resolveObstacles
        // pushes out, net zero — cats from the ±17 corner spawns aim exactly
        // through the ±6,±6 pillars, caught by wave-6 diagnosis). Detour:
        // when progress stalls, swing tangentially for a beat, then re-seek.
        let mx: number;
        let mz: number;
        if (cat.detourT > 0) {
          cat.detourT -= dt;
          mx = ((dx / dist) * 0.35 + -(dz / dist) * cat.detourSide) * cat.speed;
          mz = ((dz / dist) * 0.35 + (dx / dist) * cat.detourSide) * cat.speed;
        } else {
          mx = (dx / dist) * cat.speed;
          mz = (dz / dist) * cat.speed;
        }
        // Wall-slide: pressed against a face last tick → strip the
        // into-face component so seek flows along the box toward a corner
        // instead of ramming it. (The episodic detour alone oscillated:
        // detour gained ~0.6m, plain seek dragged it back — wave-8 diag.)
        // Head-on degenerate case (seek ⟂ face, no tangential left) gets a
        // deterministic nudge on the cat's fixed detour side.
        const pnx = cat.pushNX;
        const pnz = cat.pushNZ;
        if (pnx !== 0 || pnz !== 0) {
          const into = mx * pnx + mz * pnz;
          if (into < 0) {
            mx -= pnx * into;
            mz -= pnz * into;
            const tMag = Math.hypot(mx, mz);
            if (tMag < cat.speed * 0.3) {
              if (tMag > cat.speed * 0.02) {
                // Amplify the direction the projection already prefers
                // (shortest way around). A fixed-side nudge here FIGHTS the
                // natural slide at corners — instrumented run showed a
                // tick-perfect limit cycle on the (-6,-6) pillar (corner
                // nudge SE vs west-face slide N, alternating forever).
                const boost = (cat.speed * 0.7) / tMag;
                mx += mx * boost;
                mz += mz * boost;
              } else {
                // Truly dead-center head-on: only here is an arbitrary
                // (per-cat fixed) side needed to break symmetry.
                mx += -pnz * cat.detourSide * cat.speed * 0.7;
                mz += pnx * cat.detourSide * cat.speed * 0.7;
              }
            }
          }
        }
        for (const other of state.cats) {
          if (other === cat || other.phase !== 'alive') continue;
          const sx = cat.x - other.x;
          const sz = cat.z - other.z;
          const sd = Math.hypot(sx, sz);
          if (sd > 0.001 && sd < SEPARATION_DIST) {
            const push = (SEPARATION_DIST - sd) / SEPARATION_DIST;
            mx += (sx / sd) * push * 2.2;
            mz += (sz / sd) * push * 2.2;
          }
        }
        cat.x += mx * dt;
        cat.z += mz * dt;
        this.resolveObstacles(cat, state);
        cat.x = Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, cat.x));
        cat.z = Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, cat.z));
        // Net-progress watchdog: every 1.2s, require ≥0.5m of NET
        // displacement (per-tick stall checks miss pocket oscillation —
        // the cat moves plenty each tick while going nowhere between two
        // crate faces). Failing the window = detour episode + side flip
        // when in contact, so successive windows explore both ways out.
        cat.stuckT += dt;
        if (cat.stuckT >= 1.2) {
          const netDX = cat.x - cat.progressX;
          const netDZ = cat.z - cat.progressZ;
          if (
            netDX * netDX + netDZ * netDZ < 0.25 &&
            dist > spec.meleeRange + 0.5 &&
            cat.detourT <= 0
          ) {
            if (cat.pushNX !== 0 || cat.pushNZ !== 0) {
              cat.detourSide = cat.detourSide === 1 ? -1 : 1;
            }
            cat.detourT = 0.8; // ~2m of tangential travel at rusher speed
          }
          cat.stuckT = 0;
          cat.progressX = cat.x;
          cat.progressZ = cat.z;
        }
      } else {
        // Gunner, inside fire range, beyond melee range: hold the preferred
        // distance and strafe. The windup/fire state machine below runs
        // independently of this movement so a cornered gunner still shoots.
        const rs = spec.ranged;
        const dirX = dx / dist;
        const dirZ = dz / dist;
        let mx = 0;
        let mz = 0;
        if (dist > rs.preferredRange + 1) {
          mx += dirX * cat.speed;
          mz += dirZ * cat.speed;
        } else if (dist < rs.preferredRange - 1.5) {
          mx -= dirX * cat.speed;
          mz -= dirZ * cat.speed;
        }
        mx += -dirZ * cat.strafeDir * cat.speed;
        mz += dirX * cat.strafeDir * cat.speed;
        for (const other of state.cats) {
          if (other === cat || other.phase !== 'alive') continue;
          const sx = cat.x - other.x;
          const sz = cat.z - other.z;
          const sd = Math.hypot(sx, sz);
          if (sd > 0.001 && sd < SEPARATION_DIST) {
            const push = (SEPARATION_DIST - sd) / SEPARATION_DIST;
            mx += (sx / sd) * push * 2.2;
            mz += (sz / sd) * push * 2.2;
          }
        }
        cat.x += mx * dt;
        cat.z += mz * dt;
        const pushedOut = this.resolveObstacles(cat, state);
        const preX = cat.x;
        const preZ = cat.z;
        cat.x = Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, cat.x));
        cat.z = Math.max(-ARENA_CLAMP, Math.min(ARENA_CLAMP, cat.z));
        const hitWall = cat.x !== preX || cat.z !== preZ;

        cat.strafeTimer -= dt;
        if (cat.strafeTimer <= 0 || pushedOut || hitWall) {
          cat.strafeDir = cat.strafeDir === 1 ? -1 : 1;
          cat.strafeTimer = 1.2 + Math.random() * 1.0;
        }
      }

      // Ranged windup/fire state machine — gated purely on fire range, not
      // on which movement branch ran above, so a gunner cornered at melee
      // range still shoots back.
      if (spec.ranged && dist <= spec.ranged.fireRange) {
        const rs = spec.ranged;
        const los = hasLineOfSight(state.level.staticColliders, cat.x, cat.z, px, pz);
        if (cat.windup > 0) {
          if (!los) {
            cat.windup = 0; // fairness: the telegraph requires an unbroken sightline
          } else {
            cat.windup = Math.max(0, cat.windup - dt);
            if (cat.windup === 0) {
              cat.burstLeft = rs.burst;
              cat.burstTimer = 0;
            }
          }
        } else if (cat.fireCooldown <= 0 && cat.burstLeft <= 0 && los) {
          cat.windup = rs.windup;
          bus.emit('enemy:windup', { id: cat.id, x: cat.x, z: cat.z });
        }

        if (cat.burstLeft > 0) {
          cat.burstTimer -= dt;
          if (cat.burstTimer <= 0) {
            this.projectiles.spawn(cat.x, cat.z, cat.scale, px, targetEyeY, pz, rs);
            bus.emit('enemy:fired', { id: cat.id, x: cat.x, z: cat.z });
            cat.burstLeft--;
            cat.burstTimer = rs.burstInterval;
            if (cat.burstLeft <= 0) cat.fireCooldown = rs.cooldown;
          }
        }
      }
    }

    this.projectiles.fixedStep(state);

    // Despawn the fully-dead.
    for (let i = state.cats.length - 1; i >= 0; i--) {
      const cat = state.cats[i];
      if (!cat || cat.phase !== 'dying' || cat.deadFor < DESPAWN_AFTER) continue;
      state.cats.splice(i, 1);
      const vis = this.visuals.get(cat.id);
      if (vis) {
        this.scene.remove(vis.group);
        this.visuals.delete(cat.id);
      }
    }
    state.score.catsAlive = state.cats.reduce(
      (n, c) => n + (c.phase === 'alive' ? 1 : 0),
      0,
    );
  }

  /** Per rendered frame: hand each cat's state to its visual, which owns
   *  all posing (walk/run cycle, hit-react, melee swipe, windup eye-flare,
   *  death anim/keel-over + sink + eye-glow fade). */
  frameUpdate(state: GameState, nowS: number): void {
    for (const cat of state.cats) {
      const vis = this.visuals.get(cat.id);
      if (!vis) continue;
      vis.update(cat, nowS);
    }
  }

  /** Circle-vs-rotated-box push-out so cats slide around pillars/crates
   *  instead of clipping through them. Cheap: the collider list is small.
   *  Returns true if any collider actually pushed the cat (gunners use
   *  this to trigger a strafe-direction flip). */
  private resolveObstacles(cat: CatData, state: GameState): boolean {
    const r = OBSTACLE_RADIUS * cat.scale;
    let pushed = false;
    cat.pushNX = 0;
    cat.pushNZ = 0;
    for (const box of state.level.staticColliders) {
      if (box.y + box.hy <= OBSTACLE_MIN_TOP_Y) continue;
      const dx = cat.x - box.x;
      const dz = cat.z - box.z;
      const c = Math.cos(box.rotY);
      const s = Math.sin(box.rotY);
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const cx = Math.max(-box.hx, Math.min(box.hx, lx));
      const cz = Math.max(-box.hz, Math.min(box.hz, lz));
      const ox = lx - cx;
      const oz = lz - cz;
      const distSq = ox * ox + oz * oz;
      if (distSq >= r * r) continue;

      let nx: number;
      let nz: number;
      let push: number;
      const dist = Math.sqrt(distSq);
      if (dist > 1e-4) {
        nx = ox / dist;
        nz = oz / dist;
        push = r - dist;
      } else {
        // Cat center landed inside the box: escape along the nearer face.
        const penX = box.hx - Math.abs(lx);
        const penZ = box.hz - Math.abs(lz);
        if (penX < penZ) {
          nx = lx < 0 ? -1 : 1;
          nz = 0;
          push = penX + r;
        } else {
          nx = 0;
          nz = lz < 0 ? -1 : 1;
          push = penZ + r;
        }
      }
      cat.x += (nx * c + nz * s) * push;
      cat.z += (-nx * s + nz * c) * push;
      // ACCUMULATE world-space normals — in a multi-box pocket (the 4-crate
      // pile near (-1.9,-1.5) pinned a cat when last-push-wins made the
      // slide directions cancel) the sum points out the pocket's mouth.
      cat.pushNX += nx * c + nz * s;
      cat.pushNZ += -nx * s + nz * c;
      pushed = true;
    }
    if (pushed) {
      const n = Math.hypot(cat.pushNX, cat.pushNZ);
      if (n > 1e-6) {
        cat.pushNX /= n;
        cat.pushNZ /= n;
      }
    }
    return pushed;
  }

  /** Spawns this wave's composition (EnemyConfig.waveComposition) around
   *  the spawn ring, preferring points far from the player. Returns the
   *  spawned count (for the wave:started event). */
  private spawnWave(state: GameState, px: number, pz: number): number {
    const composition = waveComposition(state.score.wave);
    const ranked = [...SPAWN_POINTS].sort(
      (a, b) =>
        Math.hypot(b[0] - px, b[1] - pz) - Math.hypot(a[0] - px, a[1] - pz),
    );
    for (let i = 0; i < composition.length; i++) {
      const archetypeId = composition[i]!;
      const spec = ARCHETYPES[archetypeId];
      const point = ranked[i % ranked.length] ?? [0, -17.5];
      const jitter = () => (Math.random() - 0.5) * 1.6;
      const id = this.nextId++;
      const cat: CatData = {
        id,
        archetype: archetypeId,
        x: point[0] + jitter(),
        y: 0,
        z: point[1] + jitter(),
        yaw: 0,
        hp: spec.hp,
        maxHp: spec.hp,
        scale: spec.scale,
        phase: 'alive',
        speed: spec.speedMin + Math.random() * (spec.speedMax - spec.speedMin),
        flinch: 0,
        attackCooldown: 0.5,
        fireCooldown: 0.8 + Math.random() * 0.7, // 0.8–1.5s so gunners don't sync-fire
        windup: 0,
        burstLeft: 0,
        burstTimer: 0,
        strafeDir: Math.random() < 0.5 ? -1 : 1,
        strafeTimer: 1.2 + Math.random() * 1.0,
        stuckT: 0,
        detourT: 0,
        detourSide: Math.random() < 0.5 ? -1 : 1,
        pushNX: 0,
        pushNZ: 0,
        progressX: 0, // re-anchored to the real position right after creation
        progressZ: 0,
        deadFor: 0,
        meleeAnim: 0,
        deathStyle: 0,
      };
      cat.progressX = cat.x;
      cat.progressZ = cat.z;
      state.cats.push(cat);
      state.enemySpawnQueue.push({ id, x: cat.x, z: cat.z, scale: cat.scale });
      const vis = buildCatVisual(id, spec);
      vis.group.position.set(cat.x, 0, cat.z);
      this.scene.add(vis.group);
      this.visuals.set(id, vis);
      bus.emit('enemy:spawned', { id, archetype: archetypeId });
    }
    return composition.length;
  }

  private kill(state: GameState, cat: CatData, headshot: boolean): void {
    cat.phase = 'dying';
    cat.deadFor = 0;
    cat.deathStyle = headshot ? 1 : 0; // headshot slams forward, body falls back
    state.score.kills++;
    state.enemyRemoveQueue.push(cat.id); // hitbox gone immediately
    const spec = ARCHETYPES[cat.archetype];
    // Score + combo: chain kills within 4s to climb the multiplier.
    const s = state.score;
    const now = performance.now() / 1000;
    if (now < s.comboEndsAt) s.combo = Math.min(8, s.combo + 1);
    else {
      s.combo = 1;
      this.lastStreakTier = 0;
    }
    s.comboEndsAt = now + 4;
    // Streak tier: fires only on tier RISE within this chain (never per kill,
    // never on a plain first kill at combo 1 — tier 0 there never beats 0).
    const tier = s.combo >= 8 ? 3 : s.combo >= 4 ? 2 : s.combo >= 2 ? 1 : 0;
    if (tier > this.lastStreakTier) {
      this.lastStreakTier = tier;
      bus.emit('score:streak', { tier: tier as 1 | 2 | 3, combo: s.combo });
    }
    s.score += Math.round(100 * spec.scoreMult * (headshot ? 1.5 : 1) * s.combo);
    if (s.score > s.best) {
      s.best = s.score;
      try {
        localStorage.setItem('cod-best', String(s.best));
      } catch {
        /* private mode */
      }
    }
    // TUNA economy (wave-8): 10 base / 20 heavy archetype, +5 headshot bonus.
    state.upgrades.tuna +=
      (cat.archetype === 'heavy' ? 20 : 10) + (headshot ? 5 : 0);
    bus.emit('enemy:killed', { id: cat.id, archetype: cat.archetype, headshot, x: cat.x, z: cat.z });
  }

  private restart(): void {
    const state = this.stateRef;
    if (!state) return;
    for (const cat of state.cats) state.enemyRemoveQueue.push(cat.id);
    state.cats.length = 0;
    for (const vis of this.visuals.values()) this.scene.remove(vis.group);
    this.visuals.clear();
    state.score.kills = 0;
    state.score.wave = 0;
    state.score.catsAlive = 0;
    state.score.score = 0;
    state.score.combo = 1;
    state.score.comboEndsAt = 0;
    state.score.shots = 0;
    state.score.hits = 0;
    state.upgrades.tuna = 0;
    state.upgrades.clawsLvl = 0;
    state.upgrades.pocketsLvl = 0;
    state.upgrades.livesLvl = 0;
    this.lastStreakTier = 0;
    this.waveTimer = 0;
    this.waveCleared = true; // restart cleanup must not read as a cleared wave
  }
}
