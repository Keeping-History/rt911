import { describe, expect, it } from "vitest";
import { formatPlayhead, type LoopClock, playheadAt } from "./loopClock";

const T0 = Date.parse("2001-09-11T12:00:00Z");
const MIN = 60_000;
const START = T0;
const END = T0 + 30 * MIN;

function clock(over: Partial<LoopClock>): LoopClock {
	return {
		anchorVirtual: START,
		anchorWall: 1000,
		speed: 10,
		scrubbing: false,
		paused: false,
		...over,
	};
}

describe("playheadAt", () => {
	it("advances at the clock's speed from the anchor", () => {
		// 10× default: 1 min of wall time → 10 min of playhead.
		expect(playheadAt(clock({}), 1000 + MIN, START, END)).toBe(START + 10 * MIN);
	});

	it("scales by speed", () => {
		expect(playheadAt(clock({ speed: 20 }), 1000 + MIN, START, END)).toBe(
			START + 20 * MIN,
		);
		expect(playheadAt(clock({ speed: 50 }), 1000 + 0.5 * MIN, START, END)).toBe(
			START + 25 * MIN,
		);
	});

	it("wraps back to the window start at the live edge", () => {
		// 10× for 4 min = 40 min, one full 30 min window past the edge → 10 min in.
		expect(playheadAt(clock({}), 1000 + 4 * MIN, START, END)).toBe(START + 10 * MIN);
	});

	it("holds at the anchor while scrubbing", () => {
		const c = clock({ anchorVirtual: START + 10 * MIN, scrubbing: true });
		expect(playheadAt(c, 1000 + 60 * MIN, START, END)).toBe(START + 10 * MIN);
	});

	it("holds at the anchor while paused", () => {
		const c = clock({ anchorVirtual: START + 10 * MIN, paused: true });
		expect(playheadAt(c, 1000 + 60 * MIN, START, END)).toBe(START + 10 * MIN);
	});

	it("wraps an anchor that slid out the back of the window", () => {
		// The window slid forward past the anchor: playhead re-enters the window.
		const c = clock({ anchorVirtual: START - 2 * MIN, scrubbing: true });
		const p = playheadAt(c, 1000, START, END);
		expect(p).toBeGreaterThanOrEqual(START);
		expect(p).toBeLessThan(END);
	});
});

describe("formatPlayhead", () => {
	it("renders the display-timezone time", () => {
		// 12:00 UTC at UTC-4 → 8:00:00 AM
		expect(formatPlayhead(T0, -4)).toBe("8:00:00 AM");
	});
	it("renders UTC when the offset is zero", () => {
		expect(formatPlayhead(T0 + 2 * MIN + 41_000, 0)).toBe("12:02:41 PM");
	});
});
