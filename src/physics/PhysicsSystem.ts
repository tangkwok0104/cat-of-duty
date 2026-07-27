import type { World, RigidBody } from '@dimforge/rapier3d-compat';
import { FIXED_DT } from '../core/Time';
import type { GameState } from '../core/GameState';
import type { CrateResetter } from '../core/Capabilities';

// Perf note: rapier's translation()/rotation() getters allocate small
// objects each fixed step (6 bodies × 2 × 60Hz). Measured heap growth over
// 600 frames is 0.00MB (nursery-collected); revisit via raw wasm accessors
// only if GC pauses ever show in p95.

/** Rapier world. Static colliders and dynamic crate specs are read from
 *  GameState.level (written by the level builder); interpolatable crate
 *  transforms are written back to GameState.crates.
 *
 *  Rapier is dynamic-imported: its compat build inlines ~2 MB of WASM as
 *  base64, and splitting it out of the main chunk lets the renderer and UI
 *  parse while physics streams in. */
export class PhysicsSystem implements CrateResetter {
  private world!: World;
  private crateBodies: RigidBody[] = [];
  private spawnSpecs: { x: number; y: number; z: number; half: number }[] = [];
  private stateRef: GameState | null = null;

  async init(state: GameState): Promise<void> {
    this.stateRef = state;
    const RAPIER = await import('@dimforge/rapier3d-compat');
    // Known console warning: "using deprecated parameters for the
    // initialization function" comes from INSIDE rapier3d-compat 0.19.3
    // (its own wasm-bindgen init call) — upstream issue, not ours to fix;
    // its public init() takes no arguments.
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;

    for (const c of state.level.staticColliders) {
      // Colliders carry the visual's yaw — a rotated crate whose collider
      // stays axis-aligned means bullets and movement disagree with the eyes.
      const half = c.rotY / 2;
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(c.x, c.y, c.z)
          .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }),
      );
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz), body);
    }

    const n = state.level.dynamicBoxes.length;
    state.crates = {
      count: n,
      prevPos: new Float32Array(n * 3),
      currPos: new Float32Array(n * 3),
      prevRot: new Float32Array(n * 4),
      currRot: new Float32Array(n * 4),
    };

    for (const spec of state.level.dynamicBoxes) {
      this.spawnSpecs.push({ ...spec });
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(spec.x, spec.y, spec.z)
          .setCanSleep(true),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(spec.half, spec.half, spec.half)
          .setDensity(300)
          .setFriction(0.8)
          .setRestitution(0.05),
        body,
      );
      this.crateBodies.push(body);
    }

    // Prime both snapshots so the first interpolated frame is valid.
    this.snapshot(state);
    state.crates.prevPos.set(state.crates.currPos);
    state.crates.prevRot.set(state.crates.currRot);
  }

  fixedStep(state: GameState): void {
    // The world always steps once initialized; only the interpolation
    // buffers are conditional. (A missing buffer must not freeze physics.)
    const crates = state.crates;
    if (crates) {
      crates.prevPos.set(crates.currPos);
      crates.prevRot.set(crates.currRot);
    }
    this.world.step();
    if (crates) this.snapshot(state);
  }

  /** Re-drop the crates from their spawn heights (debug / perf runs). */
  resetCrates(): void {
    for (let i = 0; i < this.crateBodies.length; i++) {
      const body = this.crateBodies[i];
      const spec = this.spawnSpecs[i];
      if (!body || !spec) continue;
      body.setTranslation({ x: spec.x, y: spec.y, z: spec.z }, true);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0.5, y: 1.5, z: 0.3 }, true);
    }
    // Re-prime BOTH interpolation snapshots — otherwise the next rendered
    // frame lerps from the crates' old resting pose to the spawn point and
    // they visibly streak across the room for one frame.
    const state = this.stateRef;
    if (state?.crates) {
      this.snapshot(state);
      state.crates.prevPos.set(state.crates.currPos);
      state.crates.prevRot.set(state.crates.currRot);
    }
  }

  private snapshot(state: GameState): void {
    const crates = state.crates;
    if (!crates) return;
    for (let i = 0; i < this.crateBodies.length; i++) {
      const body = this.crateBodies[i];
      if (!body) continue;
      const t = body.translation();
      const r = body.rotation();
      const p3 = i * 3;
      const p4 = i * 4;
      crates.currPos[p3] = t.x;
      crates.currPos[p3 + 1] = t.y;
      crates.currPos[p3 + 2] = t.z;
      crates.currRot[p4] = r.x;
      crates.currRot[p4 + 1] = r.y;
      crates.currRot[p4 + 2] = r.z;
      crates.currRot[p4 + 3] = r.w;
    }
  }
}
