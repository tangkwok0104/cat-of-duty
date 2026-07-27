import type { GameState } from '../core/GameState';

const STAND_EYE = 0.72; // above capsule centre
const CROUCH_EYE = 0.45;
const EYE_LERP_SPEED = 10; // 1/s
const PUNCH_STIFFNESS = 90;
const PUNCH_DAMPING = 14;
const BOB_ENVELOPE_SPEED = 6;

/** Camera feel: head bob while moving on the ground, a spring-damped landing
 *  punch, and smooth crouch eye-height transitions. Pure view-space offsets —
 *  it never touches yaw/pitch from the mouse (responsiveness contract). */
export class CameraFeel {
  private bobPhase = 0;
  private bobEnvelope = 0; // 0..1, eases bob in/out
  private punch = 0;
  private punchVel = 0;

  /** Called once per rendered frame with the real frame delta. */
  frameUpdate(state: GameState, frameDt: number): void {
    const p = state.player;
    const t = state.tuning;

    // Eye height follows crouch state smoothly.
    const targetEye = p.crouching ? CROUCH_EYE : STAND_EYE;
    p.eyeOffset += (targetEye - p.eyeOffset) * Math.min(1, EYE_LERP_SPEED * frameDt);

    // Head bob: phase advances with actual horizontal speed, envelope eases
    // in when moving on the ground and out when stopping or airborne.
    const moving = p.grounded && p.speed2D > 0.5;
    const envTarget = moving ? 1 : 0;
    this.bobEnvelope +=
      (envTarget - this.bobEnvelope) * Math.min(1, BOB_ENVELOPE_SPEED * frameDt);
    if (moving) this.bobPhase += p.speed2D * t.bobFreq * frameDt;
    const amp = t.bobAmp * (p.sprinting ? 1.45 : p.crouching ? 0.6 : 1) * this.bobEnvelope;
    p.bobY = Math.sin(this.bobPhase * 2) * amp;
    p.bobX = Math.cos(this.bobPhase) * amp * 0.55;

    // Landing punch: consume the impact velocity as a downward spring impulse.
    if (p.landingImpact > 0) {
      this.punchVel -= p.landingImpact * t.punchScale * 10;
      p.landingImpact = 0;
    }
    const accel = -this.punch * PUNCH_STIFFNESS - this.punchVel * PUNCH_DAMPING;
    this.punchVel += accel * frameDt;
    this.punch += this.punchVel * frameDt;
    p.punchPitch = this.punch;
  }
}
