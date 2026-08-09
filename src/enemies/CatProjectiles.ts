import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Mesh,
  type Scene,
} from 'three';
import { FIXED_DT } from '../core/Time';
import type { GameState, StaticColliderSpec } from '../core/GameState';
import { bus } from '../core/EventBus';
import type { RangedSpec } from './EnemyConfig';

const CAP = 64;
const LIFETIME = 3; // s — matches the spec's max travel time
const RADIUS = 0.08;
/** Base cat head-ball height (see PhysicsSystem's CAT_HEAD_Y) — duplicated
 *  here as a literal rather than imported so enemies/ never reaches into
 *  physics/ (sibling systems talk through GameState/EventBus only). */
const HEAD_HEIGHT = 0.95;
const PLAYER_HIT_RADIUS = 0.45;
const PLAYER_HIT_HALF_HEIGHT = 0.9;
const ARENA_HALF = 13;
const LOS_STEP = 0.5; // m between sampled points along a sightline
const LOS_MIN_TOP_Y = 1.0; // colliders shorter than this never block LoS

const _origin = new Vector3();
const _target = new Vector3();
const _dir = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _shot = new Vector3();
const _m = new Matrix4();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
const IDENTITY_Q = new Quaternion();
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const WORLD_UP = new Vector3(0, 1, 0);
const FALLBACK_UP = new Vector3(1, 0, 0);

/** True if world point (px,pz) falls inside a yaw-rotated box's XZ
 *  footprint. Shared shape math for LoS sampling and projectile impacts. */
function insideBoxXZ(px: number, pz: number, box: StaticColliderSpec): boolean {
  const dx = px - box.x;
  const dz = pz - box.z;
  const c = Math.cos(box.rotY);
  const s = Math.sin(box.rotY);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= box.hx && Math.abs(lz) <= box.hz;
}

/** Sampled XZ segment test against the level's static colliders — the
 *  fairness gate for a gunner's windup (and reused by the harness's
 *  lineOfSightToCat probe... no, that one uses the real physics ray; this
 *  is the cheap AI-side approximation). Only colliders tall enough to
 *  plausibly block an eye-height sightline count, so the floor slab never
 *  occludes. Sampled every ~0.5m: readable beats clever for an 8-cat field. */
export function hasLineOfSight(
  colliders: readonly StaticColliderSpec[],
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / LOS_STEP));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    for (const box of colliders) {
      if (box.y + box.hy <= LOS_MIN_TOP_Y) continue;
      if (insideBoxXZ(px, pz, box)) return false;
    }
  }
  return true;
}

/** Ranged-cat projectiles: pooled (cap 64), allocation-free per step, one
 *  InstancedMesh of small amber spheres. Straight-line flight — no gravity,
 *  no lead on the target — because dodgeable is the design goal; hitscan
 *  from an AI would just be a cheap death the player can't react to. */
export class CatProjectiles {
  private readonly mesh: InstancedMesh;
  private readonly alive = new Uint8Array(CAP);
  private readonly x = new Float32Array(CAP);
  private readonly y = new Float32Array(CAP);
  private readonly z = new Float32Array(CAP);
  private readonly vx = new Float32Array(CAP);
  private readonly vy = new Float32Array(CAP);
  private readonly vz = new Float32Array(CAP);
  private readonly ttl = new Float32Array(CAP);
  private readonly shooterX = new Float32Array(CAP);
  private readonly shooterZ = new Float32Array(CAP);
  private readonly damage = new Float32Array(CAP);

  constructor(scene: Scene) {
    const mat = new MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffb13d, // matches the gunner archetype's eye colour
      emissiveIntensity: 2.5, // >=2: clears the selective-bloom threshold
      roughness: 1,
    });
    this.mesh = new InstancedMesh(new SphereGeometry(RADIUS, 8, 6), mat, CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < CAP; i++) this.mesh.setMatrixAt(i, HIDDEN);
    scene.add(this.mesh);
    bus.on('game:restart', () => this.clear());
  }

  /** Registered with PostFX the same way Viewmodel's muzzle flash is. */
  get bloomMeshes(): Mesh[] {
    return [this.mesh];
  }

  /** Fire one projectile toward (targetX,targetY,targetZ) with the spec's
   *  cone spread. Silently dropped if the pool is full — never happens in
   *  practice (MAX_FIELD_CATS × burst is far under CAP). */
  spawn(
    shooterX: number,
    shooterZ: number,
    shooterScale: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    spec: RangedSpec,
  ): void {
    let slot = -1;
    for (let i = 0; i < CAP; i++) {
      if (!this.alive[i]) {
        slot = i;
        break;
      }
    }
    if (slot === -1) return;

    const originY = HEAD_HEIGHT * shooterScale;
    _origin.set(shooterX, originY, shooterZ);
    _target.set(targetX, targetY, targetZ);
    _dir.subVectors(_target, _origin).normalize();
    _up.copy(Math.abs(_dir.dot(WORLD_UP)) > 0.98 ? FALLBACK_UP : WORLD_UP);
    _right.crossVectors(_dir, _up).normalize();
    _up.crossVectors(_right, _dir).normalize();
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spec.spread;
    _shot
      .copy(_dir)
      .addScaledVector(_right, Math.cos(a) * r)
      .addScaledVector(_up, Math.sin(a) * r)
      .normalize();

    this.alive[slot] = 1;
    this.x[slot] = shooterX;
    this.y[slot] = originY;
    this.z[slot] = shooterZ;
    this.vx[slot] = _shot.x * spec.projectileSpeed;
    this.vy[slot] = _shot.y * spec.projectileSpeed;
    this.vz[slot] = _shot.z * spec.projectileSpeed;
    this.ttl[slot] = LIFETIME;
    this.shooterX[slot] = shooterX;
    this.shooterZ[slot] = shooterZ;
    this.damage[slot] = spec.damage;
  }

  fixedStep(state: GameState): void {
    if (state.debugFreezeCats) return;
    const dt = FIXED_DT;
    const colliders = state.level.staticColliders;
    const player = state.player;
    let dirty = false;

    for (let i = 0; i < CAP; i++) {
      if (!this.alive[i]) continue;
      dirty = true;

      this.ttl[i] = (this.ttl[i] ?? 0) - dt;
      this.x[i] = (this.x[i] ?? 0) + (this.vx[i] ?? 0) * dt;
      this.y[i] = (this.y[i] ?? 0) + (this.vy[i] ?? 0) * dt;
      this.z[i] = (this.z[i] ?? 0) + (this.vz[i] ?? 0) * dt;
      const px = this.x[i] ?? 0;
      const py = this.y[i] ?? 0;
      const pz = this.z[i] ?? 0;

      let dead =
        (this.ttl[i] ?? 0) <= 0 ||
        Math.abs(px) > ARENA_HALF ||
        Math.abs(pz) > ARENA_HALF ||
        py < 0 ||
        py > 4 ||
        this.blockedByLevel(colliders, px, py, pz);

      if (!dead) {
        const ddx = px - player.currX;
        const ddz = pz - player.currZ;
        const hit =
          Math.hypot(ddx, ddz) < PLAYER_HIT_RADIUS &&
          py > player.currY - PLAYER_HIT_HALF_HEIGHT &&
          py < player.currY + PLAYER_HIT_HALF_HEIGHT;
        if (hit) {
          bus.emit('player:damaged', {
            amount: this.damage[i] ?? 0,
            fromX: this.shooterX[i] ?? 0,
            fromZ: this.shooterZ[i] ?? 0,
          });
          dead = true;
        }
      }

      if (dead) {
        this.alive[i] = 0;
        this.mesh.setMatrixAt(i, HIDDEN);
      } else {
        _p.set(px, py, pz);
        _m.compose(_p, IDENTITY_Q, _s);
        this.mesh.setMatrixAt(i, _m);
      }
    }

    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private blockedByLevel(
    colliders: readonly StaticColliderSpec[],
    x: number,
    y: number,
    z: number,
  ): boolean {
    for (const box of colliders) {
      if (y < box.y - box.hy || y > box.y + box.hy) continue;
      if (insideBoxXZ(x, z, box)) return true;
    }
    return false;
  }

  private clear(): void {
    for (let i = 0; i < CAP; i++) {
      this.alive[i] = 0;
      this.mesh.setMatrixAt(i, HIDDEN);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
