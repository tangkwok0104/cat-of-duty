import {
  BoxGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  DoubleSide,
  type Scene,
} from 'three';

const _m = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const UP = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

/** Ejected shell casings: little brass boxes popping right of the gun. */
export class ShellEjector {
  private mesh: InstancedMesh;
  private px = new Float32Array(24);
  private py = new Float32Array(24);
  private pz = new Float32Array(24);
  private vx = new Float32Array(24);
  private vy = new Float32Array(24);
  private vz = new Float32Array(24);
  private rot = new Float32Array(24);
  private ttl = new Float32Array(24);
  private cursor = 0;

  constructor(scene: Scene) {
    const brass = new MeshStandardMaterial({ color: 0xc9a34a, roughness: 0.35, metalness: 0.9 });
    this.mesh = new InstancedMesh(new BoxGeometry(0.012, 0.012, 0.028), brass, 24);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < 24; i++) this.mesh.setMatrixAt(i, HIDDEN);
    scene.add(this.mesh);
  }

  eject(x: number, y: number, z: number, rightX: number, rightZ: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % 24;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = rightX * (1.4 + Math.random() * 0.8);
    this.vy[i] = 1.8 + Math.random() * 0.8;
    this.vz[i] = rightZ * (1.4 + Math.random() * 0.8);
    this.rot[i] = Math.random() * Math.PI;
    this.ttl[i] = 0.6;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < 24; i++) {
      const t = this.ttl[i] ?? 0;
      if (t <= 0) continue;
      dirty = true;
      const nt = t - dt;
      this.ttl[i] = nt;
      if (nt <= 0) {
        this.mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      this.vy[i] = (this.vy[i] ?? 0) - 12 * dt;
      this.px[i] = (this.px[i] ?? 0) + (this.vx[i] ?? 0) * dt;
      this.py[i] = (this.py[i] ?? 0) + (this.vy[i] ?? 0) * dt;
      this.pz[i] = (this.pz[i] ?? 0) + (this.vz[i] ?? 0) * dt;
      this.rot[i] = (this.rot[i] ?? 0) + 14 * dt;
      _q.setFromAxisAngle(UP, this.rot[i] ?? 0);
      _m.compose(_p.set(this.px[i] ?? 0, this.py[i] ?? 0, this.pz[i] ?? 0), _q, _s.set(1, 1, 1));
      this.mesh.setMatrixAt(i, _m);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Tracer streaks: stretched emissive boxes from muzzle to impact. */
export class Tracers {
  private mesh: InstancedMesh;
  private ttl = new Float32Array(8);
  private cursor = 0;

  constructor(scene: Scene) {
    const mat = new MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85 });
    this.mesh = new InstancedMesh(new BoxGeometry(0.012, 0.012, 1), mat, 8);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < 8; i++) this.mesh.setMatrixAt(i, HIDDEN);
    scene.add(this.mesh);
  }

  fire(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % 8;
    _a.set(ox, oy, oz);
    _b.set(tx, ty, tz);
    const len = _a.distanceTo(_b);
    if (len < 0.5) return;
    _p.copy(_a).add(_b).multiplyScalar(0.5);
    _q.setFromUnitVectors(Z, _b.sub(_a).normalize());
    _m.compose(_p, _q, _s.set(1, 1, len));
    this.mesh.setMatrixAt(i, _m);
    this.ttl[i] = 0.045;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < 8; i++) {
      const t = this.ttl[i] ?? 0;
      if (t <= 0) continue;
      const nt = t - dt;
      this.ttl[i] = nt;
      if (nt <= 0) {
        this.mesh.setMatrixAt(i, HIDDEN);
        dirty = true;
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Bullet-impact decals: dark scorch quads stuck to static surfaces. */
export class Decals {
  private static readonly CAP = 48;
  private mesh: InstancedMesh;
  private age = new Float32Array(Decals.CAP);
  private cursor = 0;

  constructor(scene: Scene) {
    const mat = new MeshBasicMaterial({
      color: 0x17140f,
      transparent: true,
      opacity: 0.75,
      side: DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.mesh = new InstancedMesh(new PlaneGeometry(0.09, 0.09), mat, Decals.CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < Decals.CAP; i++) this.mesh.setMatrixAt(i, HIDDEN);
    scene.add(this.mesh);
  }

  place(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % Decals.CAP;
    _a.set(nx, ny, nz).normalize();
    _q.setFromUnitVectors(Z, _a);
    // Nudge off the surface to dodge z-fighting.
    _p.set(x + nx * 0.006, y + ny * 0.006, z + nz * 0.006);
    const k = 0.8 + Math.random() * 0.5;
    _m.compose(_p, _q, _s.set(k, k, 1));
    this.mesh.setMatrixAt(i, _m);
    this.age[i] = 10; // seconds on the wall
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < Decals.CAP; i++) {
      const t = this.age[i] ?? 0;
      if (t <= 0) continue;
      const nt = t - dt;
      this.age[i] = nt;
      if (nt <= 0) {
        this.mesh.setMatrixAt(i, HIDDEN);
        dirty = true;
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
