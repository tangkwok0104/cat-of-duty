import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  Vector3,
  DoubleSide,
  type PerspectiveCamera,
} from 'three';
import type { WeaponConfig } from './WeaponConfig';

const _muzzle = new Vector3();

/** Parameterized placeholder box-gun (per-config silhouette) held by a cat
 *  paw, parented to the camera. Three distinct reads: carbine, wide-bore
 *  pump, long scoped rifle. Swapped for real models when /assets lands. */
export class Viewmodel {
  readonly group = new Group();
  private guns = new Map<string, Group>();
  private muzzleTips = new Map<string, Vector3>();
  private flashLight: PointLight;
  private flashStar: Mesh;
  private active: WeaponConfig | null = null;
  /** Backward kick offset (spring-recovered by WeaponSystem). */
  kickZ = 0;
  /** Switch dip 0..1 (1 = fully lowered). */
  dip = 0;
  /** Sway offsets written by WeaponSystem. */
  swayX = 0;
  swayY = 0;

  private static readonly HIP = { x: 0.17, y: -0.15, z: -0.34, roll: 0.03 };
  private static readonly ADS = { x: 0, y: -0.088, z: -0.26, roll: 0 };

  constructor(camera: PerspectiveCamera, configs: readonly WeaponConfig[]) {
    for (const cfg of configs) {
      const gun = this.buildGun(cfg);
      gun.visible = false;
      this.guns.set(cfg.id, gun);
      this.group.add(gun);
    }

    this.flashLight = new PointLight(0xffc46e, 0, 7, 2);
    const flashMat = new MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffcf7d,
      emissiveIntensity: 14,
      transparent: true,
      opacity: 0.95,
      side: DoubleSide,
      depthWrite: false,
    });
    // Star flash: three planes sharing the barrel axis — reads as a burst
    // from any angle instead of a white card.
    this.flashStar = new Mesh(new PlaneGeometry(0.065, 0.065), flashMat);
    const fin1 = new Mesh(new PlaneGeometry(0.09, 0.028), flashMat);
    fin1.rotation.y = Math.PI / 2;
    const fin2 = new Mesh(new PlaneGeometry(0.028, 0.09), flashMat);
    fin2.rotation.x = Math.PI / 2;
    this.flashStar.add(fin1, fin2);
    this.flashStar.visible = false;
    this.group.add(this.flashStar, this.flashLight);

    this.setPose(0);
    camera.add(this.group);
  }

  private buildGun(cfg: WeaponConfig): Group {
    const m = cfg.model;
    const gunmetal = new MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.38, metalness: 0.75 });
    const polymer = new MeshStandardMaterial({ color: 0x3a3d33, roughness: 0.8, metalness: 0.1 });
    const fur = new MeshStandardMaterial({ color: 0xc9924f, roughness: 0.95, metalness: 0 });
    const accent = new MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffb02e,
      emissiveIntensity: 1.1,
      roughness: 1,
    });

    const gun = new Group();
    const receiver = new Mesh(new BoxGeometry(0.05, 0.075, m.receiverLen), gunmetal);
    const barrelZ = -m.receiverLen / 2 - m.barrelLen / 2 + 0.02;
    const barrel = new Mesh(
      new CylinderGeometry(m.barrelRadius, m.barrelRadius, m.barrelLen, 10),
      gunmetal,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.012, barrelZ);
    const mag = new Mesh(new BoxGeometry(0.032, m.magH, 0.05), polymer);
    mag.position.set(0, -0.04 - m.magH / 2, -0.03);
    mag.rotation.x = 0.12;
    const stock = new Mesh(new BoxGeometry(0.04, 0.06, 0.14), polymer);
    stock.position.set(0, -0.012, m.receiverLen / 2 + 0.06);
    const chip = new Mesh(new BoxGeometry(0.054, 0.006, 0.03), accent);
    chip.position.set(0, 0.04, m.receiverLen / 2 - 0.05);

    const paw1 = new Mesh(new SphereGeometry(0.032, 10, 8), fur);
    paw1.position.set(-0.005, -0.07, 0.06);
    const paw2 = new Mesh(new SphereGeometry(0.034, 10, 8), fur);
    paw2.position.set(0, -0.035, barrelZ + m.barrelLen / 2 - 0.02);
    paw2.scale.set(1, 0.8, 1.4);

    gun.add(receiver, barrel, mag, stock, chip, paw1, paw2);

    if (m.scope) {
      const tube = new Mesh(new CylinderGeometry(0.02, 0.02, 0.14, 12), gunmetal);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(0, 0.065, -0.02);
      gun.add(tube);
    } else {
      const frontSight = new Mesh(new BoxGeometry(0.006, 0.03, 0.012), gunmetal);
      frontSight.position.set(0, 0.052, barrelZ + 0.02);
      const rearSight = new Mesh(new BoxGeometry(0.024, 0.022, 0.012), gunmetal);
      rearSight.position.set(0, 0.048, m.receiverLen / 2 - 0.08);
      gun.add(frontSight, rearSight);
    }
    if (m.pump) {
      const pump = new Mesh(new BoxGeometry(0.05, 0.045, 0.12), polymer);
      pump.position.set(0, -0.03, barrelZ + 0.05);
      gun.add(pump);
    }

    // Muzzle tip in group-local space (for flash placement + tracer origin).
    this.muzzleTips.set(cfg.id, new Vector3(0, 0.012, barrelZ - m.barrelLen / 2 - 0.02));
    return gun;
  }

  show(cfg: WeaponConfig): void {
    this.active = cfg;
    for (const [id, gun] of this.guns) gun.visible = id === cfg.id;
    const tip = this.muzzleTips.get(cfg.id);
    if (tip) {
      this.flashStar.position.copy(tip);
      this.flashLight.position.copy(tip);
    }
  }

  /** Compose hip↔ADS pose + recoil kick + switch dip + sway. */
  setPose(ads: number): void {
    const h = Viewmodel.HIP;
    const a = Viewmodel.ADS;
    this.group.position.set(
      h.x + (a.x - h.x) * ads + this.swayX,
      h.y + (a.y - h.y) * ads - this.dip * 0.28 + this.swayY,
      h.z + (a.z - h.z) * ads + this.kickZ,
    );
    this.group.rotation.z = h.roll + (a.roll - h.roll) * ads;
    this.group.rotation.x = -this.dip * 0.9;
  }

  setFlash(on: boolean): void {
    this.flashStar.visible = on;
    this.flashLight.intensity = on ? 9 : 0;
    if (on) this.flashStar.rotation.z = Math.random() * Math.PI;
  }

  /** Muzzle tip in WORLD space (call after camera matrices update). */
  muzzleWorld(out: Vector3): Vector3 {
    const tip = this.active ? this.muzzleTips.get(this.active.id) : null;
    _muzzle.copy(tip ?? this.flashStar.position);
    return out.copy(this.group.localToWorld(_muzzle));
  }

  get bloomMeshes(): Mesh[] {
    return [this.flashStar];
  }
}
