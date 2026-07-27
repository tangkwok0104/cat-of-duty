import { Vector3, type Mesh, type PerspectiveCamera, type Scene } from 'three';
import type { GameState } from '../core/GameState';
import { bus } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { HitscanCaster, BulletHit } from '../core/Capabilities';
import { WEAPONS, type WeaponConfig } from './WeaponConfig';
import { Viewmodel } from './Viewmodel';
import { ImpactBurst } from './ImpactBurst';
import { ShellEjector, Tracers, Decals } from './GunFx';

const FLASH_TTL = 0.05;
const SWITCH_TIME = 0.3;
const RANGE = 150;

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
  }

  get bloomMeshes(): Mesh[] {
    return this.viewmodel.bloomMeshes;
  }

  /** Fill ammo slots from configs (called once from main after state init). */
  arm(state: GameState): void {
    this.stateRef = state;
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

  /** 1/2/3 keys (routed by main). Cancels reload, lowers, raises. */
  requestSwitch(slot: number, nowS: number): void {
    const state = this.stateRef;
    if (!state || slot === state.weapon.slot || slot < 0 || slot >= WEAPONS.length) return;
    if (state.health.dead) return;
    this.pendingSlot = slot;
    state.weapon.reloading = false; // switching cancels the reload
    state.weapon.switchingUntil = nowS + SWITCH_TIME;
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
      if (w.flashTtl <= 0) this.viewmodel.setFlash(false);
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
    this.viewmodel.setFlash(true);

    // 2D recoil pattern (halved in ADS).
    const step = cfg.recoilPattern[Math.min(this.patternIndex, cfg.recoilPattern.length - 1)];
    this.patternIndex++;
    const adsMult = 1 - w.ads * 0.35;
    if (step) {
      w.recoilPitch += step[0] * adsMult;
      this.recoilVelP += step[0] * 5;
      w.recoilYaw += step[1] * adsMult;
      this.recoilVelY += step[1] * 4;
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
          // Static world geometry: leave a mark.
          this.decals.place(_hit.px, _hit.py, _hit.pz, _hit.nx, _hit.ny, _hit.nz);
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
