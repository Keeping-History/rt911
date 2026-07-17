import { describe, expect, it } from "vitest";
import {
	CLOCK_RANGE_END_ISO,
	CLOCK_RANGE_START_ISO,
	clampClockIso,
	parseClockMs,
} from "./dateRange";

describe("parseClockMs", () => {
	it("treats a naive datetime as UTC", () => {
		expect(parseClockMs("2001-09-11T12:46:00")).toBe(Date.UTC(2001, 8, 11, 12, 46, 0));
	});
	it("honours an explicit zone", () => {
		expect(parseClockMs("2001-09-11T08:46:00-04:00")).toBe(Date.UTC(2001, 8, 11, 12, 46, 0));
	});
	it("returns null on junk", () => {
		expect(parseClockMs("nope")).toBeNull();
	});
});

describe("clampClockIso", () => {
	it("passes an in-range instant through unchanged", () => {
		const r = clampClockIso("2001-09-11T12:46:00");
		expect(r?.iso).toBe("2001-09-11T12:46:00.000Z");
		expect(r?.clamped).toBe(false);
	});
	it("clamps below the start up to the range start", () => {
		const r = clampClockIso("2001-09-08T00:00:00");
		expect(r?.iso).toBe(new Date(CLOCK_RANGE_START_ISO).toISOString());
		expect(r?.clamped).toBe(true);
	});
	it("clamps above the end down to the range end", () => {
		const r = clampClockIso("2001-09-20T00:00:00");
		expect(r?.iso).toBe(new Date(CLOCK_RANGE_END_ISO).toISOString());
		expect(r?.clamped).toBe(true);
	});
	it("returns null for an unparseable request", () => {
		expect(clampClockIso("not a date")).toBeNull();
	});
	it("honours custom bounds", () => {
		const r = clampClockIso("2001-09-11T00:00:00", "2001-09-11T06:00:00Z", "2001-09-11T18:00:00Z");
		expect(r?.iso).toBe("2001-09-11T06:00:00.000Z");
		expect(r?.clamped).toBe(true);
	});
});
