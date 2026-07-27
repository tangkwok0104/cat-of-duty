import { Vector3, type Mesh, type PerspectiveCamera, type Scene } from 'three';
import { MAG_SIZE, RESERVE_START, type GameState } from '../core/GameState';
import { bus } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { HitscanCaster, BulletHit } from '../core/Capabilities';
import { Viewmodel } from './Viewmodel';
import { ImpactBurst } from './ImpactBurst';

// Slice rifle (hardcoded; M3 makes this data-driven).
const RPM = 600;
const SHOT_INTERVAL = 60 / RPM;
const DAMAGE = 34;
const HEADSHOT_MULT = 2;
const RELOAD_S = 2;
const RANGE = 120;
const RECOIL_KICK = 0.02; // rad per shot
const RECOIL_RECOVER = 10; // spring stiffness
const ADS_TIME = 0.15; // s, per slice spec
const FLASH_TTL = 0.05;

const _dir = new Vector3();
const _hit: BulletHit = { hit: false, collider: -1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };

/** The slice's single hitscan rifle: fire/reload/ADS state machine, recoil
 *  spring, muzzle flash, impact particles. Damage is resolved through
 *  GameState.colliderToEnemy and announced on the bus — this module never
 *  touches enemy internals. */
export class WeaponSystem {
  private readonly viewmodel: Viewmodel;
  private readonly impacts: ImpactBurst;
  private cooldown = 0;
  private recoilVel = 0;
  private kickVel = 0;

  constructor(
    private readonly input: Input,
    private readonly caster: HitscanCaster,
    private readonly camera: PerspectiveCamera,
    scene: Scene,
  ) {
    this.viewmodel = new Viewmodel(camera);
    this.impacts = new ImpactBurst(scene);
    bus.on('game:restart', () => this.reset());
  }

  get bloomMeshes(): Mesh[] {
    return this.viewmodel.bloomMeshes;
  }

  private reset(): void {
    // Full slice restart: fresh mag, no reload in progress.
    const w = this.stateRef?.weapon;
    if (!w) return;
    w.ammo = MAG_SIZE;
    w.reserve = RESERVE_START;
    w.reloading = false;
    w.ads = 0;
    w.recoilPitch = 0;
  }

  /** R while alive (main routes the key: alive = reload, dead = restart). */
  requestReload(nowS: number): void {
    const w = this.stateRef?.weapon;
    if (!w || w.reloading || w.ammo >= MAG_SIZE || w.reserve <= 0) return;
    if (this.stateRef?.health.dead) return;
    w.reloading = true;
    w.reloadEndsAt = nowS + RELOAD_S;
    bus.emit('weapon:reload-start', {});
  }

  private stateRef: GameState | null = null;

  /** Per rendered frame (weapon feel is frame-rate work, not physics). */
  frameUpdate(state: GameState, dt: number, nowS: number): void {
    this.stateRef = state;
    const w = state.weapon;
    const locked = this.input.locked || this.inputOverride();

    // ADS blend (RMB) — disabled while dead.
    const wantAds = locked && !state.health.dead && this.input.isButtonDown(2);
    const adsStep = dt / ADS_TIME;
    w.ads = clamp01(w.ads + (wantAds ? adsStep : -adsStep));
    this.viewmodel.setAds(easeOut(w.ads));

    // Reload completion.
    if (w.reloading && nowS >= w.reloadEndsAt) {
      const need = MAG_SIZE - w.ammo;
      const take = Math.min(need, w.reserve);
      w.ammo += take;
      w.reserve -= take;
      w.reloading = false;
      bus.emit('weapon:reload-end', {});
    }

    // Fire (LMB hold, 600 RPM).
    this.cooldown -= dt;
    const wantFire = locked && !state.health.dead && this.input.isButtonDown(0);
    if (wantFire && this.cooldown <= 0 && !w.reloading) {
      if (w.ammo > 0) {
        this.fire(state, nowS);
        this.cooldown = SHOT_INTERVAL;
      } else {
        bus.emit('weapon:dry', {});
        this.cooldown = 0.25; // don't machine-gun the dry click
      }
    }

    // Recoil spring: kick added per shot, spring pulls back to zero.
    this.recoilVel += -w.recoilPitch * RECOIL_RECOVER * dt * 6;
    this.recoilVel *= Math.max(0, 1 - 8 * dt);
    w.recoilPitch = Math.max(0, w.recoilPitch + this.recoilVel * dt);

    // Viewmodel kick spring.
    this.kickVel += -this.viewmodel.kickZ * 60 * dt;
    this.kickVel *= Math.max(0, 1 - 10 * dt);
    this.viewmodel.kickZ = Math.max(0, this.viewmodel.kickZ + this.kickVel * dt);

    // Muzzle flash TTL.
    if (w.flashTtl > 0) {
      w.flashTtl -= dt;
      if (w.flashTtl <= 0) this.viewmodel.setFlash(false);
    }

    this.impacts.update(dt, state.player.yaw);
  }

  private fire(state: GameState, nowS: number): void {
    const w = state.weapon;
    w.ammo--;
    w.lastShotAt = nowS;
    w.flashTtl = FLASH_TTL;
    this.viewmodel.setFlash(true);
    w.recoilPitch += RECOIL_KICK;
    this.recoilVel += RECOIL_KICK * 6;
    this.viewmodel.kickZ = Math.min(0.06, this.viewmodel.kickZ + 0.035);

    // Ray straight through the camera centre.
    this.camera.getWorldDirection(_dir);
    const o = this.camera.position;
    this.caster.castBullet(o.x, o.y, o.z, _dir.x, _dir.y, _dir.z, RANGE, _hit);

    let hitEnemy = false;
    if (_hit.hit) {
      this.impacts.spawn(_hit.px, _hit.py, _hit.pz, _hit.nx, _hit.ny, _hit.nz);
      const enemy = state.colliderToEnemy.get(_hit.collider);
      if (enemy) {
        const cat = state.cats.find((c) => c.id === enemy.id && c.phase === 'alive');
        if (cat) {
          hitEnemy = true;
          const dmg = enemy.part === 'head' ? DAMAGE * HEADSHOT_MULT : DAMAGE;
          cat.hp -= dmg;
          bus.emit('enemy:hit', { id: cat.id, part: enemy.part, damage: dmg, killed: cat.hp <= 0 });
        }
      }
    }
    bus.emit('weapon:fired', { hit: hitEnemy });
  }

  private inputOverride(): boolean {
    return this.input.captureOverride;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
