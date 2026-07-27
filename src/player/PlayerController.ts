import { FIXED_DT } from '../core/Time';
import type { GameState } from '../core/GameState';
import type { Input } from '../core/Input';

const PITCH_LIMIT = (89 * Math.PI) / 180;
const _delta = { dx: 0, dy: 0 };

/** The player's decision layer. Per rendered frame: applies raw mouse deltas
 *  to yaw/pitch (same frame, no smoothing). Per fixed step: runs the small
 *  movement FSM (sprint/crouch gates, coyote time, jump buffering) and writes
 *  a movement intent for the physics character controller to execute. */
export class PlayerController {
  /** ms since the player was last grounded (coyote window). */
  private airborneMs = 0;
  /** ms remaining on a buffered jump press (0 = none). */
  private jumpBufferMs = 0;

  constructor(private readonly input: Input) {}

  /** Called once per rendered frame, before the camera is posed. */
  frameLook(state: GameState): void {
    this.input.consumeMouseDelta(_delta);
    const p = state.player;
    const sens = state.tuning.sensitivity;
    p.yaw -= _delta.dx * sens;
    p.pitch -= _delta.dy * sens;
    if (p.pitch > PITCH_LIMIT) p.pitch = PITCH_LIMIT;
    if (p.pitch < -PITCH_LIMIT) p.pitch = -PITCH_LIMIT;
    // Published for weapon sway — never used for camera rotation.
    p.lookDeltaX = _delta.dx;
    p.lookDeltaY = _delta.dy;
  }

  /** Fixed-step FSM → movement intent. Runs BEFORE PhysicsSystem.fixedStep. */
  fixedStep(state: GameState): void {
    const input = this.input;
    const intent = state.playerIntent;
    const p = state.player;
    const t = state.tuning;
    const stepMs = FIXED_DT * 1000;

    // Wish direction: keyboard axes rotated into world space by yaw.
    // Camera basis at yaw (three YXZ, yaw 0 faces -Z):
    //   forward = (-sin, 0, -cos)   right = (cos, 0, -sin)
    let fwd = 0; // W..S
    let str = 0; // A..D
    if (input.isDown('KeyW')) fwd += 1;
    if (input.isDown('KeyS')) fwd -= 1;
    if (input.isDown('KeyD')) str += 1;
    if (input.isDown('KeyA')) str -= 1;
    const len = Math.hypot(fwd, str);
    if (len > 0) {
      fwd /= len;
      str /= len;
    }
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    intent.wishX = -sin * fwd + cos * str;
    intent.wishZ = -cos * fwd - sin * str;

    // Crouch is a hold; sprint needs forward motion and excludes crouch.
    intent.crouch = input.isDown('ControlLeft') || input.isDown('KeyC');
    intent.sprint = input.isDown('ShiftLeft') && fwd > 0 && !intent.crouch;

    // Coyote time: allow a jump for a short window after walking off a ledge.
    if (p.grounded) this.airborneMs = 0;
    else this.airborneMs += stepMs;

    // Jump buffering: a press slightly before landing still counts.
    if (input.wasPressed('Space')) this.jumpBufferMs = t.jumpBufferMs;
    else this.jumpBufferMs = Math.max(0, this.jumpBufferMs - stepMs);

    const canJump = p.grounded || this.airborneMs <= t.coyoteMs;
    intent.jump = this.jumpBufferMs > 0 && canJump;
    if (intent.jump) {
      this.jumpBufferMs = 0;
      this.airborneMs = t.coyoteMs + 1; // no double coyote jump
    }

    input.clearEdges();
  }
}
