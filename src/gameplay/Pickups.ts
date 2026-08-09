import {
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  type Scene,
} from 'three';
import { FIXED_DT } from '../core/Time';
import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';
import { WEAPONS } from '../weapons/WeaponConfig';
import { buildPickupLabel, drawAmmoIcon, drawHealthIcon, type PickupLabelHandle } from './PickupLabel';

const CAP = 16;
const DROP_CHANCE = 0.3;
/** Below this hp a drop is health; at/above it, ammo. */
const HEALTH_HP_THRESHOLD = 70;
const MAX_HP = 100;
const HEAL_AMOUNT = 25;

const LIFETIME = 20; // s until despawn
const BLINK_START = LIFETIME - 3; // last 3s: emissive pulses as a warning
const BLINK_FREQ = 10; // rad/s
const BASE_INTENSITY = 2.5; // >=2: clears the selective-bloom threshold
const PULSE_RANGE = 3.5; // blink swings intensity up to BASE + this

const MAGNET_RADIUS = 2;
const COLLECT_RADIUS = 0.6;
const MAGNET_SPEED = 6; // m/s glide once a useful pickup is in magnet range

const REST_Y = 0.45;
const RADIUS = 0.16;
/** Per-kind spin speed (playtest ask: pickups were unreadable on the floor —
 *  distinct motion is part of telling health/ammo apart at a glance, on top
 *  of the floating label). */
const HEALTH_SPIN_SPEED = 1.0; // rad/s
const AMMO_SPIN_SPEED = 1.8; // rad/s
const BOB_AMP = 0.06;
const BOB_FREQ = 2.2;

const HEALTH_COLOR = 0x8fd94c; // warm green
const AMMO_COLOR = 0xffab30; // amber

const HEALTH_LABEL_COLOR = '#9ee493'; // HUD --c-ok
const AMMO_LABEL_COLOR = '#ffb02e'; // HUD --c-accent
const LABEL_Y_OFFSET = 0.32; // above the octahedron's REST_Y/bob center

const KIND_HEALTH = 0;
const KIND_AMMO = 1;

const GEO = new OctahedronGeometry(RADIUS, 0);

function buildMaterial(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x000000,
    emissive: color,
    emissiveIntensity: BASE_INTENSITY,
    roughness: 1,
  });
}

/** Health/ammo drops. Dead cats have a 30% chance to leave one behind at
 *  the death spot; kind depends on the player's hp at that moment. Pooled
 *  (cap 16, oldest evicted when full), allocation-free stepping — same
 *  shape as CatProjectiles, but individual Mesh objects (not one
 *  InstancedMesh) because each pickup needs its own emissive pulse for the
 *  despawn-warning blink, which a single shared material can't give.
 *  A pickup that can't help right now (full hp / full reserve) just sits —
 *  it neither glides nor gets collected until it either becomes useful or
 *  times out. */
export class Pickups {
  private readonly alive = new Uint8Array(CAP);
  private readonly kind = new Uint8Array(CAP); // 0 = health, 1 = ammo
  private readonly x = new Float32Array(CAP);
  private readonly z = new Float32Array(CAP);
  private readonly age = new Float32Array(CAP);
  private readonly meshes: Mesh[] = [];
  private readonly mats: MeshStandardMaterial[] = [];
  /** Floating name+icon labels, one per pool slot, added straight to the
   *  scene — NOT parented to `meshes[i]`, since the octahedron spins at
   *  1–1.8 rad/s and would drag the text around with it. */
  private readonly labels: PickupLabelHandle[] = [];
  private stateRef: GameState | null = null;

  constructor(scene: Scene) {
    for (let i = 0; i < CAP; i++) {
      const mat = buildMaterial(HEALTH_COLOR);
      const mesh = new Mesh(GEO, mat);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.mats.push(mat);

      const label = buildPickupLabel(['HEALTH'], HEALTH_LABEL_COLOR, drawHealthIcon);
      scene.add(label.sprite);
      this.labels.push(label);
    }
    bus.on('enemy:killed', ({ x, z }) => this.tryDrop(x, z));
    bus.on('game:restart', () => this.clear());
  }

  /** Registered with PostFX the same way CatProjectiles' glow spheres are. */
  get bloomMeshes(): Mesh[] {
    return this.meshes;
  }

  fixedStep(state: GameState): void {
    this.stateRef = state;
    const dt = FIXED_DT;
    const px = state.player.currX;
    const pz = state.player.currZ;

    for (let i = 0; i < CAP; i++) {
      if (!this.alive[i]) continue;

      const age = (this.age[i] ?? 0) + dt;
      this.age[i] = age;
      if (age >= LIFETIME) {
        this.despawn(i);
        continue;
      }

      if (state.debugFreezeCats) continue; // harness determinism: no magnet/collect

      const k = this.kind[i] ?? KIND_HEALTH;
      if (!this.isUseful(state, k)) continue; // does nothing right now — stays put

      const x = this.x[i] ?? 0;
      const z = this.z[i] ?? 0;
      const dx = px - x;
      const dz = pz - z;
      const dist = Math.hypot(dx, dz);

      if (dist < COLLECT_RADIUS) {
        this.collect(state, i, k);
      } else if (dist < MAGNET_RADIUS) {
        const step = Math.min(1, (MAGNET_SPEED * dt) / dist);
        this.x[i] = x + dx * step;
        this.z[i] = z + dz * step;
      }
    }
  }

  /** Per rendered frame: spin, float bob, label position, and the
   *  near-despawn emissive blink. Position/rotation only — collection state
   *  never changes here. */
  frameUpdate(nowS: number): void {
    for (let i = 0; i < CAP; i++) {
      if (!this.alive[i]) continue;
      const mesh = this.meshes[i];
      const mat = this.mats[i];
      if (!mesh || !mat) continue;

      const k = this.kind[i] ?? KIND_HEALTH;
      const x = this.x[i] ?? 0;
      const z = this.z[i] ?? 0;
      const meshY = REST_Y + Math.sin(nowS * BOB_FREQ + i) * BOB_AMP;
      mesh.position.set(x, meshY, z);
      mesh.rotation.y = nowS * (k === KIND_HEALTH ? HEALTH_SPIN_SPEED : AMMO_SPIN_SPEED) + i;

      const label = this.labels[i];
      if (label) label.sprite.position.set(x, meshY + LABEL_Y_OFFSET, z);

      const age = this.age[i] ?? 0;
      mat.emissiveIntensity =
        age >= BLINK_START
          ? BASE_INTENSITY +
            ((Math.sin((age - BLINK_START) * BLINK_FREQ) + 1) / 2) * PULSE_RANGE
          : BASE_INTENSITY;
    }
  }

  private tryDrop(x: number, z: number): void {
    const state = this.stateRef;
    if (!state || Math.random() >= DROP_CHANCE) return;
    const k = state.health.hp < HEALTH_HP_THRESHOLD ? KIND_HEALTH : KIND_AMMO;
    this.spawn(x, z, k);
  }

  /** health: any hp missing. ammo: reserve below its cap — reserveStart
   *  doubles as that cap, since nothing in WeaponSystem ever raises reserve
   *  past its starting value today. */
  private isUseful(state: GameState, k: number): boolean {
    if (k === KIND_HEALTH) return state.health.hp < MAX_HP;
    const cfg = WEAPONS[state.weapon.slot];
    const slot = state.weapon.slots[state.weapon.slot];
    if (!cfg || !slot) return false;
    return slot.reserve < cfg.reserveStart;
  }

  private spawn(x: number, z: number, k: number): void {
    let slot = -1;
    for (let i = 0; i < CAP; i++) {
      if (!this.alive[i]) {
        slot = i;
        break;
      }
    }
    if (slot === -1) {
      // Pool full: evict the oldest live pickup.
      let oldest = 0;
      let oldestAge = -Infinity;
      for (let i = 0; i < CAP; i++) {
        const a = this.age[i] ?? 0;
        if (a > oldestAge) {
          oldestAge = a;
          oldest = i;
        }
      }
      slot = oldest;
    }

    this.alive[slot] = 1;
    this.kind[slot] = k;
    this.x[slot] = x;
    this.z[slot] = z;
    this.age[slot] = 0;

    const mat = this.mats[slot];
    if (mat) {
      mat.emissive.setHex(k === KIND_HEALTH ? HEALTH_COLOR : AMMO_COLOR);
      mat.emissiveIntensity = BASE_INTENSITY;
    }
    const mesh = this.meshes[slot];
    if (mesh) {
      mesh.visible = true;
      mesh.position.set(x, REST_Y, z);
    }

    // Redraw unconditionally — on pool-eviction reuse this slot's label may
    // still show the previous occupant's kind, and a stale label is exactly
    // the "what is that on the floor" bug this system exists to fix.
    const label = this.labels[slot];
    if (label) {
      const isHealth = k === KIND_HEALTH;
      label.draw(
        [isHealth ? 'HEALTH' : 'AMMO'],
        isHealth ? HEALTH_LABEL_COLOR : AMMO_LABEL_COLOR,
        isHealth ? drawHealthIcon : drawAmmoIcon,
      );
      label.sprite.visible = true;
      label.sprite.position.set(x, REST_Y + LABEL_Y_OFFSET, z);
    }
  }

  private collect(state: GameState, i: number, k: number): void {
    if (k === KIND_HEALTH) {
      state.health.hp = Math.min(MAX_HP, state.health.hp + HEAL_AMOUNT);
    } else {
      const cfg = WEAPONS[state.weapon.slot];
      const slot = state.weapon.slots[state.weapon.slot];
      if (cfg && slot) slot.reserve = Math.min(cfg.reserveStart, slot.reserve + cfg.mag);
    }
    bus.emit('pickup:collected', { kind: k === KIND_HEALTH ? 'health' : 'ammo' });
    this.despawn(i);
  }

  private despawn(i: number): void {
    this.alive[i] = 0;
    const mesh = this.meshes[i];
    if (mesh) mesh.visible = false;
    const label = this.labels[i];
    if (label) label.sprite.visible = false;
  }

  private clear(): void {
    for (let i = 0; i < CAP; i++) this.despawn(i);
  }
}
