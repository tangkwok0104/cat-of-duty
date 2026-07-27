import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  DoubleSide,
  type PerspectiveCamera,
} from 'three';

/** Placeholder box-rifle held by a cat paw, parented to the camera.
 *  Deliberately ugly-but-readable (slice rule); swapped for a real model
 *  when /assets gets the Kenney pack. Hip↔ADS positions are lerped by the
 *  WeaponSystem via setAds(). */
export class Viewmodel {
  readonly group = new Group();
  private readonly flashLight: PointLight;
  private readonly flashQuad: Mesh;
  /** Backward kick offset (spring-recovered by WeaponSystem). */
  kickZ = 0;

  private static readonly HIP = { x: 0.17, y: -0.15, z: -0.34, roll: 0.03 };
  private static readonly ADS = { x: 0, y: -0.088, z: -0.26, roll: 0 };

  constructor(camera: PerspectiveCamera) {
    const gunmetal = new MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.38, metalness: 0.75 });
    const polymer = new MeshStandardMaterial({ color: 0x3a3d33, roughness: 0.8, metalness: 0.1 });
    const fur = new MeshStandardMaterial({ color: 0xc9924f, roughness: 0.95, metalness: 0 });
    const accent = new MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffb02e,
      emissiveIntensity: 2.2,
      roughness: 1,
    });

    const receiver = new Mesh(new BoxGeometry(0.05, 0.075, 0.3), gunmetal);
    const barrel = new Mesh(new CylinderGeometry(0.014, 0.014, 0.24, 10), gunmetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.012, -0.26);
    const handguard = new Mesh(new BoxGeometry(0.042, 0.05, 0.16), polymer);
    handguard.position.set(0, -0.005, -0.19);
    const mag = new Mesh(new BoxGeometry(0.032, 0.11, 0.05), polymer);
    mag.position.set(0, -0.085, -0.03);
    mag.rotation.x = 0.12;
    const stock = new Mesh(new BoxGeometry(0.04, 0.06, 0.14), polymer);
    stock.position.set(0, -0.012, 0.2);
    const frontSight = new Mesh(new BoxGeometry(0.006, 0.03, 0.012), gunmetal);
    frontSight.position.set(0, 0.052, -0.33);
    const rearSight = new Mesh(new BoxGeometry(0.024, 0.022, 0.012), gunmetal);
    rearSight.position.set(0, 0.048, -0.02);
    // Small identity chip, not a glowing billboard — the gun is gunmetal
    // first, brand-amber only as a wink.
    const stripe = new Mesh(new BoxGeometry(0.054, 0.006, 0.03), accent);
    stripe.position.set(0, 0.032, 0.09);
    accent.emissiveIntensity = 1.1;

    // The paw: two furry knuckle spheres on the grip, one on the handguard.
    const paw1 = new Mesh(new SphereGeometry(0.032, 10, 8), fur);
    paw1.position.set(-0.005, -0.07, 0.06);
    const paw2 = new Mesh(new SphereGeometry(0.028, 10, 8), fur);
    paw2.position.set(0.02, -0.06, 0.075);
    const paw3 = new Mesh(new SphereGeometry(0.034, 10, 8), fur);
    paw3.position.set(0, -0.035, -0.17);
    paw3.scale.set(1, 0.8, 1.4);

    this.flashLight = new PointLight(0xffc46e, 0, 7, 2);
    this.flashLight.position.set(0, 0.012, -0.42);
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
    // from any viewing angle instead of a white card.
    this.flashQuad = new Mesh(new PlaneGeometry(0.065, 0.065), flashMat);
    this.flashQuad.position.copy(this.flashLight.position);
    const fin1 = new Mesh(new PlaneGeometry(0.09, 0.028), flashMat);
    fin1.rotation.y = Math.PI / 2;
    const fin2 = fin1.clone();
    fin2.rotation.x = Math.PI / 2;
    this.flashQuad.add(fin1, fin2);
    this.flashQuad.visible = false;

    this.group.add(
      receiver, barrel, handguard, mag, stock, frontSight, rearSight, stripe,
      paw1, paw2, paw3, this.flashLight, this.flashQuad,
    );
    this.setAds(0);
    camera.add(this.group);
  }

  /** Blend hip → sights (0..1) plus the current recoil kick. */
  setAds(ads: number): void {
    const h = Viewmodel.HIP;
    const a = Viewmodel.ADS;
    this.group.position.set(
      h.x + (a.x - h.x) * ads,
      h.y + (a.y - h.y) * ads,
      h.z + (a.z - h.z) * ads + this.kickZ,
    );
    this.group.rotation.z = h.roll + (a.roll - h.roll) * ads;
  }

  setFlash(on: boolean): void {
    this.flashQuad.visible = on;
    this.flashLight.intensity = on ? 9 : 0;
    if (on) this.flashQuad.rotation.z = Math.random() * Math.PI;
  }

  /** Emissive meshes for the selective bloom pass. */
  get bloomMeshes(): Mesh[] {
    return [this.flashQuad];
  }
}
