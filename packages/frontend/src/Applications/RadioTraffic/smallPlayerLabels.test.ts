import { describe, expect, it } from "vitest";
import { durationSecondsLabel, startLabel, zoneLabel } from "./smallPlayerLabels";

/** 2001-09-11T12:33:00Z — 8:33 AM in New York, the design's own example. */
const AA11_MS = Date.UTC(2001, 8, 11, 12, 33, 0);

describe("zoneLabel", () => {
	it("names Eastern as a listener would", () => {
		// The offset the desktop is seeded to on 2001-09-11.
		expect(zoneLabel(-4)).toBe("ET");
	});

	it("still says ET on standard time", () => {
		expect(zoneLabel(-5)).toBe("ET");
	});

	it("does not claim Eastern for an offset that is not Eastern", () => {
		// The whole reason this is derived and not written into the markup:
		// Classicy's Date & Time panel can move the offset, and a stamp that kept
		// saying ET over Pacific time would be a lie with nothing to catch it.
		expect(zoneLabel(-7)).toBe("UTC-7");
		expect(zoneLabel(1)).toBe("UTC+1");
	});

	it("names zero UTC rather than UTC+0", () => {
		expect(zoneLabel(0)).toBe("UTC");
	});

	it("falls back to UTC for an unusable offset", () => {
		expect(zoneLabel(Number.NaN)).toBe("UTC");
	});
});

describe("startLabel", () => {
	// 2001-09-11T16:00Z — noon in New York, later the same display-day as
	// AA11_MS (8:33 AM ET). The clock's own current instant (issue #523).
	const SAME_DAY_NOW_MS = Date.UTC(2001, 8, 11, 16, 0, 0);
	// 2001-09-12T16:00Z — a different display-day from AA11_MS.
	const NEXT_DAY_NOW_MS = Date.UTC(2001, 8, 12, 16, 0, 0);

	it("prints the design's date, time and zone when the clock reads a different day", () => {
		expect(startLabel(AA11_MS, -4, NEXT_DAY_NOW_MS)).toBe("9/11/2001 8:33 AM ET");
	});

	it("drops the date when the clock reads the same day, keeping the time and zone", () => {
		expect(startLabel(AA11_MS, -4, SAME_DAY_NOW_MS)).toBe("8:33 AM ET");
	});

	it("shifts by the DISPLAY offset rather than the browser's own zone", () => {
		// The same instant, read by a desktop set to UTC. Were this formatted in
		// the runner's local zone the answer would change with the machine.
		expect(startLabel(AA11_MS, 0, NEXT_DAY_NOW_MS)).toBe("9/11/2001 12:33 PM UTC");
	});

	it("carries the date across a day boundary the offset creates", () => {
		// 2001-09-11T02:00Z is still the 10th in New York, and a collapsed lane
		// has no card header to correct a wrong date with — checked against the
		// clock reading the 10th (same day, date dropped) and the 11th (kept).
		const startMs = Date.UTC(2001, 8, 11, 2, 0, 0);
		expect(startLabel(startMs, -4, Date.UTC(2001, 8, 10, 20, 0, 0))).toBe("10:00 PM ET");
		expect(startLabel(startMs, -4, Date.UTC(2001, 8, 11, 12, 0, 0))).toBe("9/10/2001 10:00 PM ET");
	});

	it("keeps the date when the clock's current instant is unusable", () => {
		// A null or non-finite nowMs is not "today is unknowable" grounds to
		// drop the only thing telling a listener what day this was — fail safe.
		expect(startLabel(AA11_MS, -4, null)).toBe("9/11/2001 8:33 AM ET");
		expect(startLabel(AA11_MS, -4, Number.NaN)).toBe("9/11/2001 8:33 AM ET");
	});

	it("has nothing to say about a row with no usable start", () => {
		expect(startLabel(null, -4, SAME_DAY_NOW_MS)).toBeNull();
		expect(startLabel(Number.NaN, -4, SAME_DAY_NOW_MS)).toBeNull();
	});
});

describe("durationSecondsLabel", () => {
	it("spells the duration out, as the design does", () => {
		expect(durationSecondsLabel(68)).toBe("68 seconds");
	});

	it("does not print '1 seconds'", () => {
		expect(durationSecondsLabel(1)).toBe("1 second");
	});

	it("keeps counting in seconds past a minute", () => {
		// Deliberately NOT the card's MM:SS — the collapsed player is a summary,
		// and "125 seconds" reads at a glance where "02:05" asks for arithmetic.
		expect(durationSecondsLabel(125)).toBe("125 seconds");
	});

	it("rounds a fractional duration rather than printing it", () => {
		expect(durationSecondsLabel(67.6)).toBe("68 seconds");
	});

	it("never reports a negative length", () => {
		// itemTiming already clamps, but a card must not be the thing that finds
		// out it stopped.
		expect(durationSecondsLabel(-3)).toBe("0 seconds");
	});

	it("has nothing to say about a row with no usable duration", () => {
		expect(durationSecondsLabel(null)).toBeNull();
		expect(durationSecondsLabel(Number.NaN)).toBeNull();
	});
});
