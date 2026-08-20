import { describe, expect, it } from "vitest";
import { RADAR_BASE, type RadarIndex, frameUrlFor, stampForUtcMs } from "./weatherRadar";

describe("stampForUtcMs", () => {
	it("floors to the 300s bucket (UTC)", () => {
		expect(stampForUtcMs(Date.parse("2001-09-11T13:04:59.999Z"))).toBe("200109111300");
		expect(stampForUtcMs(Date.parse("2001-09-11T13:05:00.000Z"))).toBe("200109111305");
	});

	it("formats month/day/hour/minute zero-padded", () => {
		expect(stampForUtcMs(Date.parse("2001-01-02T03:00:00.000Z"))).toBe("200101020300");
	});

	it("rolls over a day boundary", () => {
		expect(stampForUtcMs(Date.parse("2001-09-11T23:59:59.999Z"))).toBe("200109112355");
	});
});

function buildIndex(overrides: Partial<RadarIndex> = {}): RadarIndex {
	return {
		bounds: [
			[-126.0, 50.0],
			[-66.0, 50.0],
			[-66.0, 24.0],
			[-126.0, 24.0],
		],
		frames: ["200109111300", "200109111305", "200109111315"], // gap at :10 (missing)
		missing: ["200109111310"],
		interval_seconds: 300,
		key_prefix: "weather/radar/",
		key_pattern: "n0r_{stamp}.png",
		...overrides,
	};
}

describe("frameUrlFor", () => {
	it("returns the exact frame URL on an exact stamp hit", () => {
		const index = buildIndex();
		const url = frameUrlFor(index, Date.parse("2001-09-11T13:05:00.000Z"));
		expect(url).toBe(`${RADAR_BASE}weather/radar/n0r_200109111305.png`);
	});

	it("walks back to the nearest earlier frame over a missing stamp", () => {
		const index = buildIndex();
		// 13:10 is missing; nearest earlier available is 13:05.
		const url = frameUrlFor(index, Date.parse("2001-09-11T13:10:00.000Z"));
		expect(url).toBe(`${RADAR_BASE}weather/radar/n0r_200109111305.png`);
	});

	it("returns null before the first available frame", () => {
		const index = buildIndex();
		const url = frameUrlFor(index, Date.parse("2001-09-11T12:00:00.000Z"));
		expect(url).toBeNull();
	});

	it("returns null when frames is empty", () => {
		const index = buildIndex({ frames: [] });
		expect(frameUrlFor(index, Date.parse("2001-09-11T13:05:00.000Z"))).toBeNull();
	});

	it("resolves the latest frame when utcMs is after the last one", () => {
		const index = buildIndex();
		const url = frameUrlFor(index, Date.parse("2001-09-11T23:00:00.000Z"));
		expect(url).toBe(`${RADAR_BASE}weather/radar/n0r_200109111315.png`);
	});
});
