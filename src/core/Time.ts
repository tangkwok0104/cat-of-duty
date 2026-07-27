/** Fixed-timestep constants. Physics steps at exactly FIXED_DT; rendering
 *  interpolates between the previous and current physics state. */
export const FIXED_DT = 1 / 60;

/** Max physics steps per rendered frame. If we fall further behind than
 *  this (tab was backgrounded, huge hitch), we drop the excess time instead
 *  of spiraling — a visible skip beats a frozen tab. */
export const MAX_CATCHUP_STEPS = 5;

/** Longest frame delta we accept, in ms. Anything above is clamped so a
 *  debugger pause or laptop sleep doesn't produce a physics explosion. */
export const MAX_FRAME_MS = 100;
