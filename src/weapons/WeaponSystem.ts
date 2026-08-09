import { Vector3, type Mesh, type PerspectiveCamera, type Scene } from 'three';
import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { HitscanCaster, BulletHit } from '../core/Capabilities';
import { FIXED_DT } from '../core/Time';
import { WEAPONS, type WeaponConfig } from './WeaponConfig';
import { Viewmodel } from './Viewmodel';
import { ImpactBurst } from './ImpactBurst';
import { ShellEjector, Tracers, Decals } from './GunFx';

const FLASH_TTL = 0.075;
/** Flash stays at full intensity this long before it starts decaying —
 *  a dropped frame or two can't eat the whole muzzle flash. */
const FLASH_HOLD_S = 0.02;
const SWITCH_TIME = 0.3;
const RANGE = 150;

// Recoil jitter: each shot scales its pattern step by a random factor in
// this range so shots stop being bit-identical while the pattern stays
// learnable (see fire()).
const RECOIL_JITTER_MIN = 0.88;
const RECOIL_JITTER_MAX = 1.12;

// Movement sway (spring-damped, composes with the look-delta sway below).
// Weaker damping than the look sway on purpose — on a stop the spring is
// meant to overshoot once and settle, not just glide to rest.
const MOVE_SWAY_SPRING = 22;
const MOVE_SWAY_DAMP = 7;
const MOVE_SWAY_PITCH_PER_MPS = 0.004; // forward/back speed → pitch
const MOVE_SWAY_ROLL_PER_MPS = 0.0035; // strafe speed → roll lean
const MOVE_SWAY_YAW_PER_PX = 0.00045; // look-delta → yaw lag
const MOVE_SWAY_MAX = 0.045;
const MOVE_SWAY_YAW_MAX = 0.035;

const _dir = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _shot = new Vector3();
const _muzzle = new Vector3();
const _hit: BulletHit = { hit: false, collider: -1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };

/** Data-driven three-gun loadout. Per-gun: fire cadence, 2D recoil pattern
 *  with spring recovery, cone spread (per pellet), distance falloff,
 *  penetration, tracers/shells/decals, ADS FOV+time, reload, switch dip,
 *  positional sway + idle breathing. Damage goes through
 *  GameState.colliderToEnemy + the bus — enemy internals stay private. */
export class WeaponSystem {
  private readonly viewmodel: Viewmodel;
  private readonly impacts: ImpactBurst;
  private readonly shells: ShellEjector;
  private readonly tracers: Tracers;
  private readonly decals: Decals;
  private cooldown = 0;
  private recoilVelP = 0;
  private recoilVelY = 0;
  private kickVel = 0;
  private patternIndex = 0;
  private triggerHeld = false;
  private pendingSlot = -1;
  private swayVX = 0;
  private swayVY = 0;
  private idleT = 0;
  private moveSwayPitchVel = 0;
  private moveSwayRollVel = 0;
  private moveSwayYawVel = 0;
  private stateRef: GameState | null = null;

  constructor(
    private readonly input: Input,
    private readonly caster: HitscanCaster,
    private readonly camera: PerspectiveCamera,
    scene: Scene,
  ) {
    this.viewmodel = new Viewmodel(camera, WEAPONS);
    this.impacts = new ImpactBurst(scene);
    this.shells = new ShellEjector(scene);
    this.tracers = new Tracers(scene);
    this.decals = new Decals(scene);
    bus.on('game:restart', () => this.reset());
    // Picking a gun up off the ground auto-switches to it — the classic
    // FPS reward beat. WeaponPickups sets owned[slot] BEFORE emitting, so
    // the ownership guard in requestSwitch lets this through.
    bus.on('weapon:acquired', ({ slot }) => this.requestSwitch(slot, performance.now() / 1000));
  }

  get bloomMeshes(): Mesh[] {
    return this.viewmodel.bloomMeshes;
  }

  /** Fill ammo slots from configs (called once from main after state init).
   *  The run starts rifle-only; the rest of the arsenal is ground pickups. */
  arm(state: GameState): void {
    this.stateRef = state;
    state.weapon.owned = WEAPONS.map((_, i) => i === 0);
    state.weapon.slots = WEAPONS.map((w) => ({ ammo: w.mag, reserve: w.reserveStart }));
    state.weapon.adsFov = this.config(state).adsFov;
    this.viewmodel.show(this.config(state));
    bus.emit('weapon:switched', { slot: 0, name: WEAPONS[0]?.name ?? '' });
  }

  private config(state: GameState): WeaponConfig {
    return WEAPONS[state.weapon.slot] ?? WEAPONS[0]!;
  }

  private reset(): void {
    const state = this.stateRef;
    if (!state) return;
    state.weapon.owned = WEAPONS.map((_, i) => i === 0); // back to rifle-only
    state.weapon.slots = WEAPONS.map((w) => ({ ammo: w.mag, reserve: w.reserveStart }));
    state.weapon.slot = 0;
    state.weapon.reloading = false;
    state.weapon.ads = 0;
    state.weapon.recoilPitch = 0;
    state.weapon.recoilYaw = 0;
    state.weapon.adsFov = this.config(state).adsFov;
    this.patternIndex = 0;
    this.viewmodel.show(this.config(state));
    bus.emit('weapon:switched', { slot: 0, name: WEAPONS[0]?.name ?? '' });
  }

  /** 1/2/3/4 keys (routed by main). Cancels reload, lowers, raises.
   *  Unowned slots are ignored — main gives the HUD-chip-shake feedback. */
  requestSwitch(slot: number, nowS: number): void {
    const state = this.stateRef;
    if (!state || slot === state.weapon.slot || slot < 0 || slot >= WEAPONS.length) return;
    if (!state.weapon.owned[slot]) return;
    if (state.health.dead) return;
    this.pendingSlot = slot;
    state.weapon.reloading = false; // switching cancels the reload
    state.weapon.switchingUntil = nowS + SWITCH_TIME;
  }

  /** Debug/harness only (__cod.grantAllWeapons): own every slot, full ammo. */
  grantAllWeapons(): void {
    const state = this.stateRef;
    if (!state) return;
    state.weapon.owned = WEAPONS.map(() => true);
    for (let i = 0; i < WEAPONS.length; i++) {
      const cfg = WEAPONS[i];
      const slot = state.weapon.slots[i];
      if (!cfg || !slot) continue;
      slot.ammo = cfg.mag;
      slot.reserve = cfg.reserveStart;
    }
  }

  requestReload(nowS: number): void {
    const state = this.stateRef;
    if (!state) return;
    const w = state.weapon;
    const cfg = this.config(state);
    const slot = w.slots[w.slot];
    if (!slot || w.reloading || slot.ammo >= cfg.mag || slot.reserve <= 0) return;
    if (state.health.dead || w.switchingUntil > nowS) return;
    w.reloading = true;
    w.reloadEndsAt = nowS + cfg.reloadS;
    bus.emit('weapon:reload-start', {});
  }

  frameUpdate(state: GameState, dt: number, nowS: number): void {
    this.stateRef = state;
    const w = state.weapon;
    const cfg = this.config(state);
    const slot = w.slots[w.slot];
    if (!slot) return;
    const locked = this.input.locked || this.input.captureOverride;

    // Weapon switch: dip down, swap at the midpoint, raise.
    if (this.pendingSlot >= 0) {
      const remaining = w.switchingUntil - nowS;
      this.viewmodel.dip = Math.min(1, Math.max(0, 1 - Math.abs(remaining / (SWITCH_TIME / 2) - 1)));
      if (remaining <= SWITCH_TIME / 2 && this.pendingSlot !== w.slot) {
        w.slot = this.pendingSlot;
        this.patternIndex = 0;
        w.adsFov = this.config(state).adsFov;
        this.viewmodel.show(this.config(state));
        bus.emit('weapon:switched', { slot: w.slot, name: this.config(state).name });
      }
      if (remaining <= 0) {
        this.pendingSlot = -1;
        this.viewmodel.dip = 0;
      }
    }

    // ADS blend (per-gun speed); dead or switching = forced hip.
    const wantAds =
      locked && !state.health.dead && this.pendingSlot < 0 && this.input.isButtonDown(2);
    const adsStep = dt / cfg.adsTimeS;
    w.ads = clamp01(w.ads + (wantAds ? adsStep : -adsStep));

    // Reload completion.
    if (w.reloading && nowS >= w.reloadEndsAt) {
      const need = cfg.mag - slot.ammo;
      const take = Math.min(need, slot.reserve);
      slot.ammo += take;
      slot.reserve -= take;
      w.reloading = false;
      bus.emit('weapon:reload-end', {});
    }

    // Recoil pattern index decays back to 0 when not firing.
    if (nowS - w.lastShotAt > cfg.recoilResetS) this.patternIndex = 0;

    // Trigger. Semi-autos need a fresh press per shot.
    this.cooldown -= dt;
    const held = locked && !state.health.dead && this.pendingSlot < 0 && this.input.isButtonDown(0);
    const canTrigger = cfg.auto ? held : held && !this.triggerHeld;
    if (canTrigger && this.cooldown <= 0 && !w.reloading) {
      if (slot.ammo > 0) {
        this.fire(state, cfg, nowS);
        this.cooldown = 60 / cfg.rpm;
      } else if (slot.reserve > 0) {
        // Empty mag, ammo in reserve: auto-reload instead of a dry click.
        // requestReload is self-guarded and sets w.reloading synchronously,
        // so this branch can't re-enter next frame either way — the
        // cooldown just debounces the trigger while the reload spins up.
        this.requestReload(nowS);
        this.cooldown = 0.25;
      } else {
        bus.emit('weapon:dry', {});
        this.cooldown = 0.25;
      }
    }
    this.triggerHeld = held;

    // Recoil springs (pitch + yaw) — additive, recover to zero.
    this.recoilVelP += -w.recoilPitch * 60 * dt;
    this.recoilVelP *= Math.max(0, 1 - 8 * dt);
    w.recoilPitch = Math.max(0, w.recoilPitch + this.recoilVelP * dt);
    this.recoilVelY += -w.recoilYaw * 60 * dt;
    this.recoilVelY *= Math.max(0, 1 - 8 * dt);
    w.recoilYaw += this.recoilVelY * dt;

    // Viewmodel kick spring + sway + idle breathing.
    this.kickVel += -this.viewmodel.kickZ * 60 * dt;
    this.kickVel *= Math.max(0, 1 - 10 * dt);
    this.viewmodel.kickZ = Math.max(0, this.viewmodel.kickZ + this.kickVel * dt);

    const adsDamp = 1 - w.ads * 0.8;
    const targetSwayX = -state.player.lookDeltaX * 0.00035 * adsDamp;
    const targetSwayY = state.player.lookDeltaY * 0.00028 * adsDamp;
    this.swayVX += (targetSwayX - this.viewmodel.swayX) * 30 * dt;
    this.swayVX *= Math.max(0, 1 - 12 * dt);
    this.viewmodel.swayX = clampAbs(this.viewmodel.swayX + this.swayVX * dt, 0.02);
    this.swayVY += (targetSwayY - this.viewmodel.swayY) * 30 * dt;
    this.swayVY *= Math.max(0, 1 - 12 * dt);
    this.idleT += dt;
    const idle = Math.sin(this.idleT * 1.7) * 0.0016 * adsDamp;
    this.viewmodel.swayY = clampAbs(this.viewmodel.swayY + this.swayVY * dt, 0.02) + idle;

    // Movement sway: forward/back speed pitches the gun, strafe speed rolls
    // it, and turning adds yaw lag — the "gun has weight" layer, additive
    // on top of the look sway above. Velocity is read from the last FIXED
    // physics step (curr-prev), not this render frame's dt, so it stays
    // frame-rate independent even though frameUpdate runs once per render.
    const dx = state.player.currX - state.player.prevX;
    const dz = state.player.currZ - state.player.prevZ;
    const sinYaw = Math.sin(state.player.yaw);
    const cosYaw = Math.cos(state.player.yaw);
    const fwdSpeed = -(dx * sinYaw + dz * cosYaw) / FIXED_DT;
    const strafeSpeed = (dx * cosYaw - dz * sinYaw) / FIXED_DT;

    const targetSwayPitch =
      clampAbs(-fwdSpeed * MOVE_SWAY_PITCH_PER_MPS, MOVE_SWAY_MAX) * adsDamp;
    const targetSwayRoll =
      clampAbs(strafeSpeed * MOVE_SWAY_ROLL_PER_MPS, MOVE_SWAY_MAX) * adsDamp;
    const targetSwayYaw =
      clampAbs(-state.player.lookDeltaX * MOVE_SWAY_YAW_PER_PX, MOVE_SWAY_YAW_MAX) * adsDamp;

    this.moveSwayPitchVel += (targetSwayPitch - this.viewmodel.swayPitch) * MOVE_SWAY_SPRING * dt;
    this.moveSwayPitchVel *= Math.max(0, 1 - MOVE_SWAY_DAMP * dt);
    this.viewmodel.swayPitch += this.moveSwayPitchVel * dt;

    this.moveSwayRollVel += (targetSwayRoll - this.viewmodel.swayRoll) * MOVE_SWAY_SPRING * dt;
    this.moveSwayRollVel *= Math.max(0, 1 - MOVE_SWAY_DAMP * dt);
    this.viewmodel.swayRoll += this.moveSwayRollVel * dt;

    this.moveSwayYawVel += (targetSwayYaw - this.viewmodel.swayYaw) * MOVE_SWAY_SPRING * dt;
    this.moveSwayYawVel *= Math.max(0, 1 - MOVE_SWAY_DAMP * dt);
    this.viewmodel.swayYaw += this.moveSwayYawVel * dt;

    // Scoped guns: past ~85% ADS the gun would sit inside the near plane —
    // hide it and let the HUD scope overlay take over (standard solution).
    const scoped = cfg.model.scope && w.ads > 0.85;
    if (scoped !== w.scoped) {
      w.scoped = scoped;
      this.viewmodel.group.visible = !scoped;
    }

    this.viewmodel.setPose(easeOut(w.ads));

    if (w.flashTtl > 0) {
      w.flashTtl -= dt;
      if (w.flashTtl <= 0) {
        w.flashTtl = 0;
        this.viewmodel.setFlashIntensity(0);
      } else {
        // Full brightness for the hold window, then a squared falloff to
        // zero — a fading ember instead of a binary on/off flash.
        const holdFrom = FLASH_TTL - FLASH_HOLD_S;
        const intensity = w.flashTtl >= holdFrom ? 1 : (w.flashTtl / FLASH_TTL) ** 2;
        this.viewmodel.setFlashIntensity(intensity);
      }
    }

    this.impacts.update(dt, state.player.yaw);
    this.shells.update(dt);
    this.tracers.update(dt);
    this.decals.update(dt);
  }

  private fire(state: GameState, cfg: WeaponConfig, nowS: number): void {
    const w = state.weapon;
    const slot = w.slots[w.slot];
    if (!slot) return;
    slot.ammo--;
    w.lastShotAt = nowS;
    w.flashTtl = FLASH_TTL;
    this.viewmodel.setFlashIntensity(1);

    // 2D recoil pattern (halved in ADS), jittered so shots aren't
    // bit-identical — one roll per shot applied to both axes keeps the
    // kick direction coherent (pattern stays learnable).
    const step = cfg.recoilPattern[Math.min(this.patternIndex, cfg.recoilPattern.length - 1)];
    this.patternIndex++;
    const adsMult = 1 - w.ads * 0.35;
    if (step) {
      const jitter = RECOIL_JITTER_MIN + Math.random() * (RECOIL_JITTER_MAX - RECOIL_JITTER_MIN);
      w.recoilPitch += step[0] * adsMult * jitter;
      this.recoilVelP += step[0] * 5 * jitter;
      w.recoilYaw += step[1] * adsMult * jitter;
      this.recoilVelY += step[1] * 4 * jitter;
    }
    this.viewmodel.kickZ = Math.min(0.08, this.viewmodel.kickZ + (cfg.pellets > 1 ? 0.055 : 0.035));

    // Camera basis for spread cone + shell direction.
    this.camera.getWorldDirection(_dir);
    _right.crossVectors(_dir, _up.set(0, 1, 0)).normalize();
    _up.crossVectors(_right, _dir).normalize();
    const o = this.camera.position;
    this.viewmodel.muzzleWorld(_muzzle);
    this.shells.eject(_muzzle.x, _muzzle.y, _muzzle.z, _right.x, _right.z);

    const spreadDeg = cfg.spreadHipDeg + (cfg.spreadAdsDeg - cfg.spreadHipDeg) * w.ads;
    const spreadRad = (spreadDeg * Math.PI) / 180;

    // Aggregate damage per cat per trigger pull → one hit event per cat.
    let totalOnCat = 0;
    let catId = -1;
    let catPart: 'head' | 'body' = 'body';
    let anyEnemyHit = false;

    for (let p = 0; p < cfg.pellets; p++) {
      // Random point in the spread cone.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spreadRad;
      _shot
        .copy(_dir)
        .addScaledVector(_right, Math.cos(a) * r)
        .addScaledVector(_up, Math.sin(a) * r)
        .normalize();

      let ox = o.x;
      let oy = o.y;
      let oz = o.z;
      let damageMult = 1;
      for (let surface = 0; surface <= cfg.penetration; surface++) {
        this.caster.castBullet(ox, oy, oz, _shot.x, _shot.y, _shot.z, RANGE, _hit);
        if (!_hit.hit) {
          if (surface === 0 && cfg.tracer) {
            this.tracers.fire(
              _muzzle.x, _muzzle.y, _muzzle.z,
              ox + _shot.x * 40, oy + _shot.y * 40, oz + _shot.z * 40,
            );
          }
          break;
        }
        if (surface === 0 && cfg.tracer) {
          this.tracers.fire(_muzzle.x, _muzzle.y, _muzzle.z, _hit.px, _hit.py, _hit.pz);
        }
        this.impacts.spawn(_hit.px, _hit.py, _hit.pz, _hit.nx, _hit.ny, _hit.nz, 5);

        const enemy = state.colliderToEnemy.get(_hit.collider);
        if (enemy) {
          const cat = state.cats.find((c) => c.id === enemy.id && c.phase === 'alive');
          if (cat) {
            anyEnemyHit = true;
            const dist = Math.hypot(_hit.px - o.x, _hit.py - o.y, _hit.pz - o.z);
            const head = enemy.part === 'head';
            const dmg =
              cfg.damage * falloffMult(cfg, dist) * (head ? cfg.headshotMult : 1) * damageMult;
            if (cat.id !== catId && catId !== -1 && totalOnCat > 0) {
              this.applyDamage(state, catId, catPart, totalOnCat);
              totalOnCat = 0;
            }
            catId = cat.id;
            if (head) catPart = 'head';
            totalOnCat += dmg;
          }
        } else {
          // Static world geometry: leave a mark + let SoundBus know (impact thud).
          this.decals.place(_hit.px, _hit.py, _hit.pz, _hit.nx, _hit.ny, _hit.nz);
          bus.emit('weapon:impact', { x: _hit.px, y: _hit.py, z: _hit.pz });
        }
        // Punch through: continue from just past the hit.
        ox = _hit.px + _shot.x * 0.06;
        oy = _hit.py + _shot.y * 0.06;
        oz = _hit.pz + _shot.z * 0.06;
        damageMult *= cfg.penetrationMult;
      }
    }
    if (catId !== -1 && totalOnCat > 0) {
      this.applyDamage(state, catId, catPart, totalOnCat);
    }
    state.score.shots++;
    if (anyEnemyHit) state.score.hits++;
    bus.emit('weapon:fired', { hit: anyEnemyHit, profile: cfg.soundProfile });
  }

  private applyDamage(state: GameState, id: number, part: 'head' | 'body', dmg: number): void {
    const cat = state.cats.find((c) => c.id === id && c.phase === 'alive');
    if (!cat) return;
    cat.hp -= dmg;
    bus.emit('enemy:hit', { id, part, damage: dmg, killed: cat.hp <= 0 });
  }
}

function falloffMult(cfg: WeaponConfig, dist: number): number {
  const f = cfg.falloff;
  if (dist <= f.start) return 1;
  if (dist >= f.end) return f.minMult;
  return 1 + ((dist - f.start) / (f.end - f.start)) * (f.minMult - 1);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampAbs(v: number, max: number): number {
  return v < -max ? -max : v > max ? max : v;
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
