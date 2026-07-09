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
		speed: 1,
		scrubbing: false,
		...over,
	};
}

describe("playheadAt", () => {
	it("advances at 1x from the anchor", () => {
		expect(playheadAt(clock({}), 1000 + 5 * MIN, START, END)).toBe(START + 5 * MIN);
	});

	it("scales by speed", () => {
		expect(playheadAt(clock({ speed: 8 }), 1000 + MIN, START, END)).toBe(
			START + 8 * MIN,
		);
		expect(playheadAt(clock({ speed: 0.25 }), 1000 + 4 * MIN, START, END)).toBe(
			START + MIN,
		);
	});

	it("wraps back to the window start at the live edge", () => {
		expect(playheadAt(clock({}), 1000 + 31 * MIN, START, END)).toBe(START + MIN);
	});

	it("holds at the anchor while scrubbing", () => {
		const c = clock({ anchorVirtual: START + 10 * MIN, scrubbing: true });
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
