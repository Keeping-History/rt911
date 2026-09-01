// Acceleration curve for holding ⏮/⏭: the longer the button is held, the
// faster the virtual clock moves. Speed ramps exponentially from the initial
// pace to the maximum over HOLD_RAMP_MS, then holds there — so a short hold
// stays a gentle minute-per-tick nudge while a long hold crosses hours.

/** Time held (ms of real time) to reach full speed. */
export const HOLD_RAMP_MS = 15_000;

/** Starting speed, in virtual seconds per real second: one minute per
 *  500ms tick — identical to the pre-acceleration fixed hold pace. */
export const HOLD_START_SPEED = 120;

/** Full speed, in virtual seconds per real second: 30 minutes per second. */
export const HOLD_MAX_SPEED = 1_800;

/**
 * Virtual-clock skip (ms) for one hold-repeat tick, given how long the
 * button has been held (`heldMs`, 0 on the first tick) and the tick
 * interval (`tickMs`). Exponential interpolation keeps every doubling of
 * speed an equal share of the ramp, which feels like steady acceleration.
 */
export function holdSeekStepMs(heldMs: number, tickMs: number): number {
	const t = Math.min(Math.max(heldMs / HOLD_RAMP_MS, 0), 1);
	const speed = HOLD_START_SPEED * (HOLD_MAX_SPEED / HOLD_START_SPEED) ** t;
	return Math.round(speed * tickMs);
}
