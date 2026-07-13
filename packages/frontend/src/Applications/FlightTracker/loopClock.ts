// Flight-specific loop constants. The generic loop-clock machinery lives in
// src/lib/loopClock.ts (shared with Weather's radar loop) and is re-exported
// here so FlightTracker-internal imports stay unchanged.

export {
	formatPlayhead,
	type LoopClock,
	playheadAt,
} from "../../lib/loopClock";

export const LOOP_SPEEDS = [10, 20, 50, 100, 500] as const;
export type LoopSpeed = (typeof LOOP_SPEEDS)[number];

export const SPEED_LABELS: Record<LoopSpeed, string> = {
	10: "10×",
	20: "20×",
	50: "50×",
	100: "100×",
	500: "500×",
};

export type LoopWindowMinutes = 30 | 90;
