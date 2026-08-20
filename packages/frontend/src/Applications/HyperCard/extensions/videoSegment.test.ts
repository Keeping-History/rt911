import { describe, expect, it } from "vitest";
import { parseBoundToSeconds, parseClock, resolveSegment, toUtcMs } from "./videoSegment";

describe("toUtcMs", () => {
	it("pins a naive datetime to UTC", () => {
		expect(toUtcMs("2001-09-11T12:46:00")).toBe(Date.UTC(2001, 8, 11, 12, 46, 0));
	});
	it("honours an explicit zone", () => {
		expect(toUtcMs("2001-09-11T12:46:00Z")).toBe(Date.UTC(2001, 8, 11, 12, 46, 0));
	});
	it("returns null on junk", () => {
		expect(toUtcMs("not a date")).toBeNull();
		expect(toUtcMs("")).toBeNull();
	});
});

describe("parseClock", () => {
	it("parses M:SS and H:MM:SS", () => {
		expect(parseClock("2:00")).toBe(120);
		expect(parseClock("1:02:03")).toBe(3723);
		expect(parseClock("0:05")).toBe(5);
	});
	it("rejects non-clock strings", () => {
		expect(parseClock("120")).toBeNull();
		expect(parseClock("2001-09-11T12:46:00")).toBeNull();
	});
});

describe("parseBoundToSeconds", () => {
	it("treats a number as an offset in seconds", () => {
		expect(parseBoundToSeconds(120, null)).toBe(120);
		expect(parseBoundToSeconds(0, null)).toBe(0);
	});
	it("treats a numeric string as an offset", () => {
		expect(parseBoundToSeconds("240", null)).toBe(240);
	});
	it("treats a clock string as an offset duration", () => {
		expect(parseBoundToSeconds("2:00", null)).toBe(120);
	});
	it("maps a date-bearing wall-clock to an offset from the channel start", () => {
		const start = toUtcMs("2001-09-11T12:40:00");
		// 6 minutes after the channel start.
		expect(parseBoundToSeconds("2001-09-11T12:46:00", start)).toBe(360);
	});
	it("needs the channel start to map wall-clock, else undefined", () => {
		expect(parseBoundToSeconds("2001-09-11T12:46:00", null)).toBeUndefined();
	});
	it("returns undefined for absent/uninterpretable values", () => {
		expect(parseBoundToSeconds(undefined, null)).toBeUndefined();
		expect(parseBoundToSeconds("", null)).toBeUndefined();
		expect(parseBoundToSeconds("nope", null)).toBeUndefined();
	});
});

describe("resolveSegment", () => {
	it("combines start and end", () => {
		expect(resolveSegment(60, 180, null)).toEqual({ startSec: 60, endSec: 180 });
	});
	it("defaults start to 0", () => {
		expect(resolveSegment(undefined, 30, null)).toEqual({ startSec: 0, endSec: 30 });
	});
	it("drops an end that is not after the start", () => {
		expect(resolveSegment(100, 90, null)).toEqual({ startSec: 100 });
		expect(resolveSegment(100, 100, null)).toEqual({ startSec: 100 });
	});
	it("maps wall-clock bounds against the channel start", () => {
		const start = toUtcMs("2001-09-11T12:40:00");
		expect(resolveSegment("2001-09-11T12:46:00", "2001-09-11T12:50:00", start)).toEqual({
			startSec: 360,
			endSec: 600,
		});
	});
});
