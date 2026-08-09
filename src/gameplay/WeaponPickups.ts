import {
  Group,
  Mesh,
  MeshStandardMaterial,
  RingGeometry,
  type Scene,
} from 'three';
import { FIXED_DT } from '../core/Time';
import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';
import { WEAPONS } from '../weapons/WeaponConfig';
import { loadModel } from '../core/Assets';

/** Fixed arsenal pickups + ammo stations (pattern-matches gameplay/Pickups:
 *  fixed-step collection, per-frame spin/bob, emissive rings registered with
 *  the selective bloom pass). Unlike the random kill-drops in Pickups, these
 *  live at FIXED spots: three ground guns (the player starts rifle-only and
 *  finds the rest) and two ammo crates on a 45 s respawn timer. Deliberately
 *  NOT gated by debugFreezeCats — walking over one is a player-driven act;
 *  the harness instead clears them via debugDespawnWeapons()
 *  (__cod.grantAllWeapons wiring in main). */

const COLLECT_RADIUS = 0.9;
/** Vertical gate so the platform gun can't be grabbed through the slab. */
const COLLECT_DY = 1.2;
const HOVER = 0.5; // gun float height above its ground
const SPIN_SPEED = 0.9; // rad/s, slow display spin
const BOB_AMP = 0.06;
const BOB_FREQ = 2.2;
const GUN_SCALE = 0.26; // GLB long axis ~1.9 → ~0.5 m display gun
const GUN_TILT = 0.15; // jaunty trophy tilt while it spins

const RING_INNER = 0.3;
const RING_OUTER = 0.42;
const RING_Y = 0.02; // above the ground, clear of z-fighting
const BASE_INTENSITY = 2.5; // >=2: clears the selective-bloom threshold
const BREATHE_RANGE = 0.6;
const BREATHE_FREQ = 2.0;

const WEAPON_RING_COLOR = 0x7fc8ff; // cool "new gear" glow — distinct from
const AMMO_RING_COLOR = 0xffab30; //   the amber ammo language (Pickups)

const STATION_RESPAWN_S = 45;
const STATION_BLINK_S = 0.7; // blink-back-in flash duration
const STATION_BLINK_FREQ = 24; // rad/s intensity strobe during the blink
const CRATE_SCALE = 0.25; // crate.glb ~1.9 wide → ~0.47 m marker crate
const CRATE_MIN_Y = -0.558; // crate.glb local minY (GreyBoxRoom bbox notes)

/** Where the guns lie. The sniper is the reward for climbing the platform
 *  (top 1.2 m); the other two hug existing cover so grabbing them is a
 *  deliberate detour, not a drive-by. The platform spot is nudged off dead
 *  centre and floats higher (`hover`) so the spinning rifle clears the
 *  crate prop parked at (8.8,-8.6), top ~1.72 — screenshot-verified clip. */
const WEAPON_SPOTS: readonly {
  slot: number; x: number; z: number; groundY: number; hover: number;
}[] = [
  { slot: 1, x: -8, z: 6.5, groundY: 0, hover: HOVER }, // SCRATCH-12 — near the SW sandbags
  { slot: 2, x: 8.05, z: -8.1, groundY: 1.2, hover: 0.68 }, // LONGWHISKER — ON the platform
  { slot: 3, x: -5.5, z: 3.2, groundY: 0, hover: HOVER }, // PURR-90 — near the west cover wall
];

const STATION_SPOTS: readonly { x: number; z: number }[] = [
  { x: 10, z: 8 },
  { x: -9, z: -9 },
];

function ringMaterial(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x000000,
    emissive: color,
    emissiveIntensity: BASE_INTENSITY,
    roughness: 1,
  });
}

export class WeaponPickups {
  // Weapon pickups (parallel to WEAPON_SPOTS).
  private readonly collected: boolean[] = [];
  private readonly gunHolders: Group[] = [];
  private readonly gunRings: Mesh[] = [];
  private readonly gunRingMats: MeshStandardMaterial[] = [];
  // Ammo stations (parallel to STATION_SPOTS).
  private readonly present: boolean[] = [];
  private readonly respawnIn = new Float32Array(STATION_SPOTS.length);
  private readonly blinkT = new Float32Array(STATION_SPOTS.length);
  private readonly stationHolders: Group[] = [];
  private readonly stationRings: Mesh[] = [];
  private readonly stationRingMats: MeshStandardMaterial[] = [];

  constructor(scene: Scene) {
    const ringGeo = new RingGeometry(RING_INNER, RING_OUTER, 32);

    for (const spot of WEAPON_SPOTS) {
      this.collected.push(false);
      const holder = new Group();
      holder.position.set(spot.x, spot.groundY + spot.hover, spot.z);
      scene.add(holder);
      this.gunHolders.push(holder);

      const mat = ringMaterial(WEAPON_RING_COLOR);
      const ring = new Mesh(ringGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(spot.x, spot.groundY + RING_Y, spot.z);
      scene.add(ring);
      this.gunRings.push(ring);
      this.gunRingMats.push(mat);

      // The gun's real GLB, small, tilted like a trophy. Lazy — the ring
      // alone marks the spot until the model resolves (never gates boot).
      const cfg = WEAPONS[spot.slot];
      if (cfg) {
        loadModel(cfg.viewModel.file)
          .then((gltf) => {
            const inst = gltf.scene.clone(true);
            inst.traverse((obj) => {
              if (obj instanceof Mesh) {
                obj.castShadow = false;
                obj.receiveShadow = false;
              }
            });
            inst.scale.setScalar(GUN_SCALE);
            inst.rotation.z = GUN_TILT;
            holder.add(inst);
          })
          .catch((err: unknown) => {
            console.error(`[WeaponPickups] failed to load ${cfg.viewModel.file}.glb`, err);
          });
      }
    }

    for (const spot of STATION_SPOTS) {
      this.present.push(true);
      const holder = new Group();
      holder.position.set(spot.x, 0, spot.z);
      scene.add(holder);
      this.stationHolders.push(holder);

      const mat = ringMaterial(AMMO_RING_COLOR);
      const ring = new Mesh(ringGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(spot.x, RING_Y, spot.z);
      scene.add(ring);
      this.stationRings.push(ring);
      this.stationRingMats.push(mat);

      loadModel('crate')
        .then((gltf) => {
          const inst = gltf.scene.clone(true);
          inst.traverse((obj) => {
            if (obj instanceof Mesh) {
              obj.castShadow = false;
              obj.receiveShadow = false;
            }
          });
          inst.scale.setScalar(CRATE_SCALE);
          inst.position.y = -CRATE_MIN_Y * CRATE_SCALE; // bottom on the floor
          holder.add(inst);
        })
        .catch((err: unknown) => {
          console.error('[WeaponPickups] failed to load crate.glb', err);
        });
    }

    bus.on('game:restart', () => this.reset());
  }

  /** Registered with PostFX like Pickups' octahedrons. */
  get bloomMeshes(): Mesh[] {
    return [...this.gunRings, ...this.stationRings];
  }

  fixedStep(state: GameState): void {
    const px = state.player.currX;
    const py = state.player.currY;
    const pz = state.player.currZ;
    const dead = state.health.dead;

    // Weapon pickups: acquire (or duplicate top-up) on walk-over.
    if (!dead) {
      for (let i = 0; i < WEAPON_SPOTS.length; i++) {
        if (this.collected[i]) continue;
        const spot = WEAPON_SPOTS[i];
        if (!spot) continue;
        const baseY = spot.groundY + spot.hover;
        if (Math.abs(py - baseY) > COLLECT_DY) continue;
        if (Math.hypot(px - spot.x, pz - spot.z) >= COLLECT_RADIUS) continue;
        this.acquire(state, i, spot.slot);
      }
    }

    // Ammo stations: collect + 45 s respawn countdown.
    for (let i = 0; i < STATION_SPOTS.length; i++) {
      const spot = STATION_SPOTS[i];
      if (!spot) continue;
      if (!this.present[i]) {
        const left = (this.respawnIn[i] ?? 0) - FIXED_DT;
        this.respawnIn[i] = left;
        if (left <= 0) this.respawnStation(i);
        continue;
      }
      const blink = this.blinkT[i] ?? 0;
      if (blink > 0) this.blinkT[i] = blink - FIXED_DT;
      if (dead) continue;
      // A station that can't top anything up just sits (same "stays until
      // useful" rule as Pickups) — no wasted 45 s cooldown on a full arsenal.
      if (!this.anyOwnedBelowReserveCap(state)) continue;
      if (Math.hypot(px - spot.x, pz - spot.z) >= COLLECT_RADIUS) continue;
      this.collectStation(state, i);
    }
  }

  /** Per rendered frame: gun spin/bob, ring breathing, station blink-in. */
  frameUpdate(nowS: number): void {
    for (let i = 0; i < WEAPON_SPOTS.length; i++) {
      if (this.collected[i]) continue;
      const spot = WEAPON_SPOTS[i];
      const holder = this.gunHolders[i];
      const mat = this.gunRingMats[i];
      if (!spot || !holder || !mat) continue;
      holder.position.y = spot.groundY + spot.hover + Math.sin(nowS * BOB_FREQ + i) * BOB_AMP;
      holder.rotation.y = nowS * SPIN_SPEED + i * 2;
      mat.emissiveIntensity =
        BASE_INTENSITY + ((Math.sin(nowS * BREATHE_FREQ + i) + 1) / 2) * BREATHE_RANGE;
    }
    for (let i = 0; i < STATION_SPOTS.length; i++) {
      if (!this.present[i]) continue;
      const ring = this.stationRings[i];
      const mat = this.stationRingMats[i];
      const holder = this.stationHolders[i];
      if (!ring || !mat || !holder) continue;
      ring.rotation.z = nowS * 0.6; // slow in-plane spin
      const blink = this.blinkT[i] ?? 0;
      if (blink > 0) {
        // Blink back in: intensity strobe + scale pop over the first ~0.7 s.
        const t = 1 - blink / STATION_BLINK_S;
        const s = Math.min(1, t / 0.35);
        holder.scale.setScalar(s);
        mat.emissiveIntensity =
          BASE_INTENSITY + ((Math.sin(blink * STATION_BLINK_FREQ) + 1) / 2) * 4;
      } else {
        if (holder.scale.x !== 1) holder.scale.setScalar(1);
        mat.emissiveIntensity =
          BASE_INTENSITY + ((Math.sin(nowS * BREATHE_FREQ + i) + 1) / 2) * BREATHE_RANGE;
      }
    }
  }

  /** Harness support (__cod.grantAllWeapons): the guns are all owned anyway,
   *  so remove the ground pickups — an aimed-shot step wandering over one
   *  must not trigger an auto-switch mid-assertion. Stations stay: their
   *  reserve top-up is capped at reserveStart, which the harness's exact
   *  ammo assertions already equal. */
  debugDespawnWeapons(): void {
    for (let i = 0; i < WEAPON_SPOTS.length; i++) this.hideWeapon(i);
  }

  private acquire(state: GameState, index: number, slotIdx: number): void {
    const cfg = WEAPONS[slotIdx];
    const slot = state.weapon.slots[slotIdx];
    if (!cfg || !slot) return;
    if (state.weapon.owned[slotIdx]) {
      // Duplicate after a restart-grant or debug: quiet ammo top-up, no switch.
      slot.reserve = Math.min(cfg.reserveStart, slot.reserve + cfg.mag);
      bus.emit('pickup:collected', { kind: 'ammo' });
    } else {
      state.weapon.owned[slotIdx] = true;
      slot.ammo = cfg.mag;
      slot.reserve = Math.min(cfg.reserveStart, cfg.mag * 2); // full mag + 2 spare
      // WeaponSystem hears this and auto-switches — the pickup dopamine hit.
      bus.emit('weapon:acquired', { slot: slotIdx, name: cfg.name });
    }
    this.hideWeapon(index);
  }

  private collectStation(state: GameState, index: number): void {
    for (let i = 0; i < WEAPONS.length; i++) {
      if (!state.weapon.owned[i]) continue;
      const cfg = WEAPONS[i];
      const slot = state.weapon.slots[i];
      if (!cfg || !slot) continue;
      slot.reserve = Math.min(cfg.reserveStart, slot.reserve + cfg.mag);
    }
    bus.emit('pickup:collected', { kind: 'ammo' }); // reuse the ammo ding
    this.present[index] = false;
    this.respawnIn[index] = STATION_RESPAWN_S;
    const holder = this.stationHolders[index];
    const ring = this.stationRings[index];
    if (holder) holder.visible = false;
    if (ring) ring.visible = false;
  }

  private respawnStation(index: number): void {
    this.present[index] = true;
    this.blinkT[index] = STATION_BLINK_S;
    const holder = this.stationHolders[index];
    const ring = this.stationRings[index];
    if (holder) {
      holder.visible = true;
      holder.scale.setScalar(0.01); // blink-in pop starts from nothing
    }
    if (ring) ring.visible = true;
  }

  private anyOwnedBelowReserveCap(state: GameState): boolean {
    for (let i = 0; i < WEAPONS.length; i++) {
      if (!state.weapon.owned[i]) continue;
      const cfg = WEAPONS[i];
      const slot = state.weapon.slots[i];
      if (cfg && slot && slot.reserve < cfg.reserveStart) return true;
    }
    return false;
  }

  private hideWeapon(index: number): void {
    this.collected[index] = true;
    const holder = this.gunHolders[index];
    const ring = this.gunRings[index];
    if (holder) holder.visible = false;
    if (ring) ring.visible = false;
  }

  private reset(): void {
    for (let i = 0; i < WEAPON_SPOTS.length; i++) {
      this.collected[i] = false;
      const holder = this.gunHolders[i];
      const ring = this.gunRings[i];
      if (holder) holder.visible = true;
      if (ring) ring.visible = true;
    }
    for (let i = 0; i < STATION_SPOTS.length; i++) {
      this.present[i] = true;
      this.respawnIn[i] = 0;
      this.blinkT[i] = 0;
      const holder = this.stationHolders[i];
      const ring = this.stationRings[i];
      if (holder) {
        holder.visible = true;
        holder.scale.setScalar(1);
      }
      if (ring) ring.visible = true;
    }
  }
}
