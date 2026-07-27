import type {
  World,
  RigidBody,
  Collider,
  KinematicCharacterController,
} from '@dimforge/rapier3d-compat';
import { FIXED_DT } from '../core/Time';
import { PLAYER_SPAWN, type GameState } from '../core/GameState';
import type { CrateResetter } from '../core/Capabilities';

type RapierModule = typeof import('@dimforge/rapier3d-compat');

// Player capsule: total height = 2*(halfHeight + radius).
const CAPSULE_RADIUS = 0.35;
const STAND_HALF_HEIGHT = 0.55; // 1.8m standing
const CROUCH_HALF_HEIGHT = 0.25; // 1.2m crouched
const CROUCH_CENTER_DROP = STAND_HALF_HEIGHT - CROUCH_HALF_HEIGHT;
const DEG = Math.PI / 180;
const TERMINAL_FALL = -30;
const LANDING_IMPACT_MIN = 3; // m/s of fall before the camera punch registers

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
  private RAPIER!: RapierModule;
  private crateBodies: RigidBody[] = [];
  private spawnSpecs: { x: number; y: number; z: number; half: number }[] = [];
  private stateRef: GameState | null = null;

  // Player rig
  private playerBody!: RigidBody;
  private playerCollider!: Collider;
  private charController!: KinematicCharacterController;
  private velX = 0;
  private velY = 0;
  private velZ = 0;
  private crouched = false;

  async init(state: GameState): Promise<void> {
    this.stateRef = state;
    const RAPIER = await import('@dimforge/rapier3d-compat');
    this.RAPIER = RAPIER;
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

    // ---- Player: kinematic capsule + character controller ----
    this.playerBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        PLAYER_SPAWN.x,
        PLAYER_SPAWN.y,
        PLAYER_SPAWN.z,
      ),
    );
    this.playerCollider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(STAND_HALF_HEIGHT, CAPSULE_RADIUS).setFriction(0),
      this.playerBody,
    );
    const cc = this.world.createCharacterController(0.02);
    cc.enableAutostep(0.35, 0.15, true); // step-up onto crates/ledges
    cc.setMaxSlopeClimbAngle(50 * DEG);
    cc.setMinSlopeSlideAngle(55 * DEG);
    cc.enableSnapToGround(0.35); // stick to ground down slopes/steps
    cc.setApplyImpulsesToDynamicBodies(true); // walking into crates shoves them
    this.charController = cc;
  }

  fixedStep(state: GameState): void {
    // The world always steps once initialized; only the interpolation
    // buffers are conditional. (A missing buffer must not freeze physics.)
    const crates = state.crates;
    if (crates) {
      crates.prevPos.set(crates.currPos);
      crates.prevRot.set(crates.currRot);
    }
    // Player movement is computed and queued BEFORE world.step(), which is
    // what actually applies the kinematic translation.
    this.stepPlayer(state);
    this.world.step();
    if (crates) this.snapshot(state);
    // Player's authoritative post-step position.
    const p = state.player;
    const tr = this.playerBody.translation();
    p.currX = tr.x;
    p.currY = tr.y;
    p.currZ = tr.z;
    p.speed2D = Math.hypot(this.velX, this.velZ);
  }

  private stepPlayer(state: GameState): void {
    const p = state.player;
    const t = state.tuning;
    const intent = state.playerIntent;
    const dt = FIXED_DT;

    // Harness teleport (one-shot mailbox).
    const tp = state.playerTeleport;
    if (tp) {
      state.playerTeleport = null;
      this.playerBody.setTranslation({ x: tp.x, y: tp.y, z: tp.z }, true);
      this.velX = 0;
      this.velY = 0;
      this.velZ = 0;
      p.yaw = tp.yaw;
      p.pitch = tp.pitch;
      p.prevX = p.currX = tp.x;
      p.prevY = p.currY = tp.y;
      p.prevZ = p.currZ = tp.z;
    }

    p.prevX = p.currX;
    p.prevY = p.currY;
    p.prevZ = p.currZ;

    // Crouch transitions change the capsule (and keep the feet planted).
    if (intent.crouch !== this.crouched) {
      if (intent.crouch) this.setCrouched(true);
      else if (this.headroomClear()) this.setCrouched(false);
    }

    // Horizontal: accelerate hard toward the wish velocity — responsiveness
    // beats realism. No input on the ground = brake hard. In the air, keep
    // momentum with limited steering.
    const wishing = intent.wishX !== 0 || intent.wishZ !== 0;
    const mult = intent.sprint ? t.sprintMult : this.crouched ? t.crouchMult : 1;
    const target = t.walkSpeed * mult;
    if (wishing) {
      const accel = (p.grounded ? t.groundAccel : t.airAccel) * dt;
      this.velX = moveToward(this.velX, intent.wishX * target, accel);
      this.velZ = moveToward(this.velZ, intent.wishZ * target, accel);
    } else if (p.grounded) {
      const brake = t.stopDecel * dt;
      this.velX = moveToward(this.velX, 0, brake);
      this.velZ = moveToward(this.velZ, 0, brake);
    }

    // Vertical: jump consumes the FSM's intent; gravity always applies.
    if (intent.jump) {
      this.velY = t.jumpVel;
      intent.jump = false;
    }
    this.velY += t.gravity * dt;
    if (this.velY < TERMINAL_FALL) this.velY = TERMINAL_FALL;

    const cc = this.charController;
    cc.computeColliderMovement(this.playerCollider, {
      x: this.velX * dt,
      y: this.velY * dt,
      z: this.velZ * dt,
    });
    const move = cc.computedMovement();
    const cur = this.playerBody.translation();
    this.playerBody.setNextKinematicTranslation({
      x: cur.x + move.x,
      y: cur.y + move.y,
      z: cur.z + move.z,
    });

    const groundedNow = cc.computedGrounded();
    if (!p.grounded && groundedNow && this.velY < -LANDING_IMPACT_MIN) {
      p.landingImpact = -this.velY;
    }
    if (groundedNow) {
      if (this.velY < 0) this.velY = -0.5; // small stick for slopes/steps
    } else if (p.grounded && this.velY === -0.5) {
      this.velY = 0; // walked off a ledge: start the fall from zero, not the stick
    }
    p.grounded = groundedNow;
    p.crouching = this.crouched;
    p.sprinting = intent.sprint && wishing;
  }

  private setCrouched(on: boolean): void {
    const halfHeight = on ? CROUCH_HALF_HEIGHT : STAND_HALF_HEIGHT;
    this.playerCollider.setShape(new this.RAPIER.Capsule(halfHeight, CAPSULE_RADIUS));
    const cur = this.playerBody.translation();
    const dy = on ? -CROUCH_CENTER_DROP : CROUCH_CENTER_DROP;
    this.playerBody.setTranslation({ x: cur.x, y: cur.y + dy, z: cur.z }, true);
    const p = this.stateRef?.player;
    if (p) {
      p.currY += dy;
      p.prevY += dy; // no interpolation glitch across the resize
    }
    this.crouched = on;
  }

  /** Room to stand up? Cast a ray up from the crouched capsule's crown. */
  private headroomClear(): boolean {
    const cur = this.playerBody.translation();
    const crown = cur.y + CROUCH_HALF_HEIGHT + CAPSULE_RADIUS;
    const needed = 2 * CROUCH_CENTER_DROP + 0.02;
    const ray = new this.RAPIER.Ray(
      { x: cur.x, y: crown + 0.01, z: cur.z },
      { x: 0, y: 1, z: 0 },
    );
    const hit = this.world.castRay(
      ray,
      needed,
      true,
      undefined,
      undefined,
      this.playerCollider,
      this.playerBody,
    );
    return hit === null;
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

/** Move a value toward a target by at most maxDelta (never overshoots). */
function moveToward(value: number, target: number, maxDelta: number): number {
  const diff = target - value;
  if (Math.abs(diff) <= maxDelta) return target;
  return value + Math.sign(diff) * maxDelta;
}
