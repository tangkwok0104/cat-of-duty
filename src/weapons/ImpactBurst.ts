import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Scene,
} from 'three';

const MAX = 96;
const PER_BURST = 8;
const LIFE = 0.35; // seconds
const GRAVITY = -7;

const _m = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/** Pooled impact particles (one InstancedMesh, zero per-shot allocation).
 *  Doubles as the death "puff" — spawn() with a colour + count. */
export class ImpactBurst {
  private mesh: InstancedMesh;
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX);
  private pz = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private vz = new Float32Array(MAX);
  private ttl = new Float32Array(MAX); // <= 0 = dead
  private cursor = 0;

  constructor(scene: Scene) {
    // MeshBasicMaterial is deliberate: unlit dust motes, cheapest possible.
    const mat = new MeshBasicMaterial({ color: 0xc8bfae, transparent: true, opacity: 0.9 });
    this.mesh = new InstancedMesh(new PlaneGeometry(0.05, 0.05), mat, MAX);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, HIDDEN);
    scene.add(this.mesh);
  }

  spawn(x: number, y: number, z: number, nx: number, ny: number, nz: number, count = PER_BURST): void {
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % MAX;
      this.px[idx] = x;
      this.py[idx] = y;
      this.pz[idx] = z;
      // Scatter around the surface normal.
      this.vx[idx] = nx * 1.6 + (Math.random() - 0.5) * 2.2;
      this.vy[idx] = ny * 1.6 + Math.random() * 1.8;
      this.vz[idx] = nz * 1.6 + (Math.random() - 0.5) * 2.2;
      this.ttl[idx] = LIFE;
    }
  }

  /** Advance and billboard toward the camera-ish (screen-facing enough). */
  update(dt: number, camYaw: number): void {
    _q.setFromAxisAngle(_p.set(0, 1, 0), camYaw);
    let dirty = false;
    for (let i = 0; i < MAX; i++) {
      const t = this.ttl[i] ?? 0;
      if (t <= 0) continue;
      dirty = true;
      const nt = t - dt;
      this.ttl[i] = nt;
      if (nt <= 0) {
        this.mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      this.vy[i] = (this.vy[i] ?? 0) + GRAVITY * dt;
      this.px[i] = (this.px[i] ?? 0) + (this.vx[i] ?? 0) * dt;
      this.py[i] = (this.py[i] ?? 0) + (this.vy[i] ?? 0) * dt;
      this.pz[i] = (this.pz[i] ?? 0) + (this.vz[i] ?? 0) * dt;
      const k = nt / LIFE; // shrink out
      _m.compose(
        _p.set(this.px[i] ?? 0, this.py[i] ?? 0, this.pz[i] ?? 0),
        _q,
        _s.set(k, k, k),
      );
      this.mesh.setMatrixAt(i, _m);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
