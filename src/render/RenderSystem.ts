import {
  Scene,
  PerspectiveCamera,
  Vector3,
  Quaternion,
  Matrix4,
  type WebGLRenderer,
  type InstancedMesh,
} from 'three';
import type { GameState } from '../core/GameState';
import type { CameraPoser } from '../core/Capabilities';
import { bus } from '../core/EventBus';
import type { Lighting } from './Lighting';
import type { PostFX } from './PostFX';

// Preallocated scratch — the render hot path must not allocate.
const _pa = new Vector3();
const _pb = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _m = new Matrix4();
const ONE = new Vector3(1, 1, 1);

/** Owns the scene + camera, applies interpolated physics transforms to the
 *  dynamic crate InstancedMesh, then runs CSM update and the post chain. */
export class RenderSystem implements CameraPoser {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private dynamicCrates: InstancedMesh | null = null;
  private lighting: Lighting | null = null;
  private postfx: PostFX | null = null;

  constructor(private readonly renderer: WebGLRenderer) {
    this.camera = new PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.08,
      300,
    );
    this.camera.position.set(7.5, 1.7, 9.0);
    this.camera.lookAt(0, 1.0, 0);

    bus.on('level:built', ({ dynamicCrateMesh }) => {
      this.dynamicCrates = dynamicCrateMesh;
    });

    window.addEventListener('resize', () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.postfx?.onResize(w, h);
      this.lighting?.onResize();
    });
  }

  attach(lighting: Lighting, postfx: PostFX): void {
    this.lighting = lighting;
    this.postfx = postfx;
  }

  render(alpha: number, state: GameState): void {
    this.renderer.info.reset();
    this.applyCrateTransforms(alpha, state);
    // CSM fits cascades from camera.matrixWorld — refresh it first or the
    // fit lags one frame behind camera motion (edge shadow pop on flicks).
    this.camera.updateMatrixWorld();
    this.lighting?.update();
    this.postfx?.render();
    state.perf.drawCalls = this.renderer.info.render.calls;
    state.perf.triangles = this.renderer.info.render.triangles;
  }

  private applyCrateTransforms(alpha: number, state: GameState): void {
    const crates = state.crates;
    const mesh = this.dynamicCrates;
    if (!crates || !mesh) return;
    for (let i = 0; i < crates.count; i++) {
      const p3 = i * 3;
      const p4 = i * 4;
      _pa.set(
        crates.prevPos[p3] ?? 0,
        crates.prevPos[p3 + 1] ?? 0,
        crates.prevPos[p3 + 2] ?? 0,
      );
      _pb.set(
        crates.currPos[p3] ?? 0,
        crates.currPos[p3 + 1] ?? 0,
        crates.currPos[p3 + 2] ?? 0,
      );
      _pa.lerp(_pb, alpha);
      _qa.set(
        crates.prevRot[p4] ?? 0,
        crates.prevRot[p4 + 1] ?? 0,
        crates.prevRot[p4 + 2] ?? 0,
        crates.prevRot[p4 + 3] ?? 1,
      );
      _qb.set(
        crates.currRot[p4] ?? 0,
        crates.currRot[p4 + 1] ?? 0,
        crates.currRot[p4 + 2] ?? 0,
        crates.currRot[p4 + 3] ?? 1,
      );
      _qa.slerp(_qb, alpha);
      _m.compose(_pa, _qa, ONE);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Debug/capture hook: place the camera and aim it. */
  setCameraPose(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void {
    this.camera.position.set(px, py, pz);
    this.camera.lookAt(tx, ty, tz);
  }
}
