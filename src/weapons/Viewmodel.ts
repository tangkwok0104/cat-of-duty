import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  SphereGeometry,
  Vector3,
  DoubleSide,
  type PerspectiveCamera,
} from 'three';
import { loadModel } from '../core/Assets';
import type { WeaponConfig } from './WeaponConfig';

const _muzzle = new Vector3();
const _localPos = new Vector3();
const _localScale = new Vector3();
const _localQuat = new Quaternion();
const _localEuler = new Euler();
const _localMat = new Matrix4();

/** Parameterized placeholder box-gun (per-config silhouette) held by a cat
 *  paw, parented to the camera. Three distinct reads: carbine, wide-bore
 *  pump, long scoped rifle. Each per-gun group holds BOTH the placeholder
 *  (visible immediately) and an empty `modelHolder` — the real GLB is
 *  loaded lazily (loadModel) and, on resolve, swapped in: modelHolder gets
 *  the scene + this gun's viewModel transform, placeholder hides. Sway/
 *  recoil/ADS/dip all act on the outer `this.group`, so the swap is
 *  invisible to that feel code either way. */
export class Viewmodel {
  readonly group = new Group();
  private guns = new Map<string, Group>();
  private placeholders = new Map<string, Group>();
  private modelHolders = new Map<string, Group>();
  private muzzleTips = new Map<string, Vector3>();
  private flashLight: PointLight;
  private flashStar: Mesh;
  private flashMaterial: MeshStandardMaterial;
  private active: WeaponConfig | null = null;
  /** Backward kick offset (spring-recovered by WeaponSystem). */
  kickZ = 0;
  /** Switch dip 0..1 (1 = fully lowered). */
  dip = 0;
  /** Sway offsets written by WeaponSystem. */
  swayX = 0;
  swayY = 0;
  /** Movement-sway rotation offsets written by WeaponSystem (spring-damped
   *  pitch/roll/yaw from move speed + turning — composes with the pose
   *  rotation in setPose, additive). */
  swayPitch = 0;
  swayRoll = 0;
  swayYaw = 0;

  private static readonly HIP = { x: 0.3, y: -0.3, z: -0.32, roll: 0.06 };
  private static readonly ADS = { x: 0, y: -0.088, z: -0.26, roll: 0 };

  constructor(camera: PerspectiveCamera, configs: readonly WeaponConfig[]) {
    for (const cfg of configs) {
      const gun = this.buildGun(cfg);
      gun.visible = false;
      this.guns.set(cfg.id, gun);
      this.group.add(gun);
      this.loadRealModel(cfg);
    }
    this.loadPaw(configs);

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
    this.flashMaterial = flashMat;
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

    const placeholder = new Group();
    placeholder.add(receiver, barrel, mag, stock, chip, paw1, paw2);

    if (m.scope) {
      const tube = new Mesh(new CylinderGeometry(0.02, 0.02, 0.14, 12), gunmetal);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(0, 0.065, -0.02);
      placeholder.add(tube);
    } else {
      const frontSight = new Mesh(new BoxGeometry(0.006, 0.03, 0.012), gunmetal);
      frontSight.position.set(0, 0.052, barrelZ + 0.02);
      const rearSight = new Mesh(new BoxGeometry(0.024, 0.022, 0.012), gunmetal);
      rearSight.position.set(0, 0.048, m.receiverLen / 2 - 0.08);
      placeholder.add(frontSight, rearSight);
    }
    if (m.pump) {
      const pump = new Mesh(new BoxGeometry(0.05, 0.045, 0.12), polymer);
      pump.position.set(0, -0.03, barrelZ + 0.05);
      placeholder.add(pump);
    }
    gun.add(placeholder);
    this.placeholders.set(cfg.id, placeholder);

    // Empty until the real GLB resolves (loadRealModel); stays invisible
    // the whole time the placeholder is shown.
    const modelHolder = new Group();
    modelHolder.visible = false;
    gun.add(modelHolder);
    this.modelHolders.set(cfg.id, modelHolder);

    // Muzzle tip in group-local space (for flash placement + tracer origin).
    // Replaced with a GLB-derived tip once the real model loads.
    this.muzzleTips.set(cfg.id, new Vector3(0, 0.012, barrelZ - m.barrelLen / 2 - 0.02));
    return gun;
  }

  /** Fire-and-forget: swap the box placeholder for the real GLB once it
   *  resolves. Never awaited by callers — must not gate boot/ready. */
  private loadRealModel(cfg: WeaponConfig): void {
    const vm = cfg.viewModel;
    loadModel(vm.file)
      .then((gltf) => {
        const holder = this.modelHolders.get(cfg.id);
        if (!holder) return; // Viewmodel torn down before load finished.
        const scene = gltf.scene;
        scene.traverse((obj) => {
          if (obj instanceof Mesh) {
            obj.castShadow = false;
            obj.frustumCulled = false; // hugs the near plane; never cull it
          }
        });
        holder.position.set(vm.position[0], vm.position[1], vm.position[2]);
        holder.rotation.set(vm.rotation[0], vm.rotation[1], vm.rotation[2]);
        holder.scale.setScalar(vm.scale);
        holder.add(scene);
        holder.visible = true;
        this.placeholders.get(cfg.id)!.visible = false;

        // Re-derive the muzzle tip from the model's own transform so flash/
        // tracer anchor to the GLB's actual barrel, not the box guess.
        _localMat.compose(
          _localPos.set(vm.position[0], vm.position[1], vm.position[2]),
          _localQuat.setFromEuler(_localEuler.set(vm.rotation[0], vm.rotation[1], vm.rotation[2])),
          _localScale.setScalar(vm.scale),
        );
        const tip = new Vector3(
          vm.muzzleLocal[0],
          vm.muzzleLocal[1],
          vm.muzzleLocal[2],
        ).applyMatrix4(_localMat);
        this.muzzleTips.set(cfg.id, tip);
        if (this.active?.id === cfg.id) {
          this.flashStar.position.copy(tip);
          this.flashLight.position.copy(tip);
        }
      })
      .catch((err: unknown) => {
        console.error(`[Viewmodel] failed to load model "${vm.file}" for ${cfg.id}`, err);
      });
  }

  /** Fire-and-forget: fetch paw.glb exactly ONCE (loadModel's cache makes
   *  every call after the first a no-op network-wise) then clone one
   *  instance per gun that opts in via `viewModel.paw`. Attached straight
   *  to the per-gun `gun` group — a sibling of the placeholder/modelHolder
   *  — so it's visible immediately (no GLB-swap wait) and inherits every
   *  bit of that group's motion (sway/recoil/dip) plus the scope-hides-
   *  viewmodel visibility toggle in WeaponSystem for free. */
  private loadPaw(configs: readonly WeaponConfig[]): void {
    loadModel('paw')
      .then((gltf) => {
        for (const cfg of configs) {
          const pawCfg = cfg.viewModel.paw;
          if (!pawCfg) continue; // this gun ships corner-anchored, no grip prop
          const gun = this.guns.get(cfg.id);
          if (!gun) continue; // Viewmodel torn down before load finished
          const paw = gltf.scene.clone(true);
          paw.traverse((obj) => {
            if (obj instanceof Mesh) {
              obj.castShadow = false;
              obj.frustumCulled = false; // hugs the near plane; never cull it
            }
          });
          paw.position.set(pawCfg.position[0], pawCfg.position[1], pawCfg.position[2]);
          paw.rotation.set(pawCfg.rotation[0], pawCfg.rotation[1], pawCfg.rotation[2]);
          paw.scale.setScalar(pawCfg.scale);
          gun.add(paw);
        }
      })
      .catch((err: unknown) => {
        console.error('[Viewmodel] failed to load paw.glb', err);
      });
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
    this.group.rotation.z = h.roll + (a.roll - h.roll) * ads + this.swayRoll;
    this.group.rotation.x = -this.dip * 0.9 + this.swayPitch;
    this.group.rotation.y = this.swayYaw;
  }

  /** Flash decay: 0 = fully off, 1 = fresh burst. Re-rolls the star's
   *  rotation only on ignition (rising from off) so a decaying flash
   *  doesn't spin mid-fade. */
  setFlashIntensity(t: number): void {
    const on = t > 0;
    if (on && this.flashLight.intensity <= 0) {
      this.flashStar.rotation.z = Math.random() * Math.PI;
    }
    this.flashStar.visible = on;
    this.flashMaterial.opacity = 0.95 * t;
    this.flashLight.intensity = on ? 9 * t : 0;
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
