import type { Group, Scene } from 'three';
import { FIXED_DT } from '../core/Time';
import type { GameState, CatData } from '../core/GameState';
import { bus } from '../core/EventBus';
import { buildCatVisual, type CatVisual } from './CatVisual';

const CAT_HP = 100;
const ATTACK_RANGE = 1.25;
const ATTACK_DAMAGE = 10;
const ATTACK_COOLDOWN = 1.0;
const SEPARATION_DIST = 0.9;
const DESPAWN_AFTER = 2.0; // s after death
const FALL_TIME = 0.25;
const WAVE_BREATHER = 1.5; // s between waves
const MAX_CATS = 6;

/** Spawn ring: fixed points hugging the arena walls. */
const SPAWN_POINTS: readonly [number, number][] = [
  [-11, -11], [0, -11.5], [11, -11],
  [-11.5, 0], [11.5, 0],
  [-11, 11], [0, 11.5], [11, 11],
];

/** Slice cat AI: walk straight at the player, avoid each other with simple
 *  separation, claw on contact. Waves 1→2→…→6, next wave when the field is
 *  clear. Owns visuals (scene handed in by the composition root) and AI;
 *  colliders are mirrored by the physics system via GameState queues. */
export class CatSystem {
  private visuals = new Map<number, CatVisual>();
  private nextId = 1;
  private waveTimer = 0; // counts down the breather between waves
  private started = false;

  constructor(private readonly scene: Scene) {
    bus.on('enemy:hit', ({ id, killed }) => {
      const state = this.stateRef;
      if (!state) return;
      const cat = state.cats.find((c) => c.id === id);
      if (!cat || cat.phase !== 'alive') return;
      cat.flinch = 0.15;
      if (killed) this.kill(state, cat);
    });
    bus.on('game:restart', () => this.restart());
  }

  private stateRef: GameState | null = null;

  /** The slice starts its first wave once the player locks in. */
  startWaves(): void {
    this.started = true;
  }

  fixedStep(state: GameState): void {
    this.stateRef = state;
    const dt = FIXED_DT;
    const px = state.player.currX;
    const pz = state.player.currZ;

    // Wave logic: field clear → breather → next wave.
    if (this.started && !state.health.dead) {
      const anyAlive = state.cats.some((c) => c.phase === 'alive');
      if (!anyAlive) {
        this.waveTimer -= dt;
        if (this.waveTimer <= 0) {
          state.score.wave++;
          const count = Math.min(state.score.wave, MAX_CATS);
          this.spawnWave(state, count, px, pz);
          this.waveTimer = WAVE_BREATHER;
          bus.emit('wave:started', { wave: state.score.wave, count });
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
      if (cat.flinch > 0) {
        cat.flinch -= dt;
        continue; // staggered — no move, no attack
      }
      if (state.debugFreezeCats) continue; // harness determinism
      const dx = px - cat.x;
      const dz = pz - cat.z;
      const dist = Math.hypot(dx, dz);
      cat.yaw = Math.atan2(-dx, -dz) + Math.PI; // face the player
      cat.attackCooldown = Math.max(0, cat.attackCooldown - dt);

      if (dist > ATTACK_RANGE) {
        // Seek + separation (no navmesh by design — slice spec).
        let mx = (dx / dist) * cat.speed;
        let mz = (dz / dist) * cat.speed;
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
        // Stay inside the arena walls.
        cat.x = Math.max(-12.3, Math.min(12.3, cat.x));
        cat.z = Math.max(-12.3, Math.min(12.3, cat.z));
      } else if (cat.attackCooldown <= 0 && !state.health.dead) {
        cat.attackCooldown = ATTACK_COOLDOWN;
        bus.emit('player:damaged', { amount: ATTACK_DAMAGE, fromX: cat.x, fromZ: cat.z });
      }
    }

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

  /** Per rendered frame: pose visuals from AI state (fall-over on death,
   *  flinch jerk, subtle walk waddle). */
  frameUpdate(state: GameState, nowS: number): void {
    for (const cat of state.cats) {
      const vis = this.visuals.get(cat.id);
      if (!vis) continue;
      const g: Group = vis.group;
      g.position.set(cat.x, cat.y, cat.z);
      g.rotation.y = cat.yaw;
      if (cat.phase === 'dying') {
        // Keel over sideways, then sink slightly.
        const fall = Math.min(1, cat.deadFor / FALL_TIME);
        g.rotation.z = (Math.PI / 2) * fall;
        const sink = Math.max(0, cat.deadFor - FALL_TIME) * 0.12;
        g.position.y = cat.y - sink;
        const fade = Math.max(0, 1 - cat.deadFor / DESPAWN_AFTER);
        vis.eyeMat.emissiveIntensity = 2.5 * fade;
      } else {
        // Walk waddle + flinch jerk.
        const waddle = Math.sin(nowS * 9 + cat.id) * 0.05;
        g.rotation.z = waddle + (cat.flinch > 0 ? Math.sin(nowS * 70) * 0.08 : 0);
      }
    }
  }

  private spawnWave(state: GameState, count: number, px: number, pz: number): void {
    // Prefer spawn points far from the player.
    const ranked = [...SPAWN_POINTS].sort(
      (a, b) =>
        Math.hypot(b[0] - px, b[1] - pz) - Math.hypot(a[0] - px, a[1] - pz),
    );
    for (let i = 0; i < count; i++) {
      const point = ranked[i % ranked.length] ?? [0, -11.5];
      const jitter = () => (Math.random() - 0.5) * 1.6;
      const id = this.nextId++;
      const cat: CatData = {
        id,
        x: point[0] + jitter(),
        y: 0,
        z: point[1] + jitter(),
        yaw: 0,
        hp: CAT_HP,
        phase: 'alive',
        speed: 1.8 + Math.random() * 0.9,
        flinch: 0,
        attackCooldown: 0.5,
        deadFor: 0,
      };
      state.cats.push(cat);
      state.enemySpawnQueue.push({ id, x: cat.x, z: cat.z });
      const vis = buildCatVisual(id);
      vis.group.position.set(cat.x, 0, cat.z);
      this.scene.add(vis.group);
      this.visuals.set(id, vis);
    }
  }

  private kill(state: GameState, cat: CatData): void {
    cat.phase = 'dying';
    cat.deadFor = 0;
    state.score.kills++;
    state.enemyRemoveQueue.push(cat.id); // hitbox gone immediately
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
    this.waveTimer = 0;
  }
}
