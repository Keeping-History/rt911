import { describe, expect, it } from "vitest";
import {
	HOLD_MAX_SPEED,
	HOLD_RAMP_MS,
	HOLD_START_SPEED,
	holdSeekStepMs,
} from "./holdSeekRamp";

describe("holdSeekStepMs", () => {
	it("starts at the pre-acceleration pace: one minute per 500ms tick", () => {
		expect(holdSeekStepMs(0, 500)).toBe(60_000);
	});

	it("reaches 30 virtual minutes per real second at the end of the ramp", () => {
		// 1800 s/s × 0.5s tick = 15 virtual minutes per tick.
		expect(holdSeekStepMs(HOLD_RAMP_MS, 500)).toBe(900_000);
	});

	it("clamps at full speed past the ramp", () => {
		expect(holdSeekStepMs(HOLD_RAMP_MS * 3, 500)).toBe(900_000);
		expect(holdSeekStepMs(-100, 500)).toBe(60_000); // and at the start below it
	});

	it("accelerates exponentially: the ramp midpoint is the geometric mean", () => {
		const mid = holdSeekStepMs(HOLD_RAMP_MS / 2, 500);
		const geometricMean = Math.sqrt(HOLD_START_SPEED * HOLD_MAX_SPEED) * 500;
		expect(mid).toBeCloseTo(geometricMean, -1);
	});

	it("is monotonically increasing across the ramp", () => {
		let prev = 0;
		for (let heldMs = 0; heldMs <= HOLD_RAMP_MS; heldMs += 500) {
			const step = holdSeekStepMs(heldMs, 500);
			expect(step).toBeGreaterThan(prev);
			prev = step;
		}
	});
});
