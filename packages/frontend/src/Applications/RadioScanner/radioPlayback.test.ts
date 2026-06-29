import { describe, expect, it } from "vitest";
import {
	sanitizeActiveStation,
	sanitizeItemIds,
	sanitizeStationKeys,
	shouldStationPlay,
} from "./radioPlayback";

describe("shouldStationPlay", () => {
	it("returns true only for the active station", () => {
		const sel = { activeStation: "ATC" };
		expect(shouldStationPlay(sel, "ATC")).toBe(true);
		expect(shouldStationPlay(sel, "Rutgers")).toBe(false);
		expect(shouldStationPlay(sel, "")).toBe(false);
	});

	it("switching the active station silences the previous one", () => {
		const before = { activeStation: "ATC" };
		const after = { activeStation: "Rutgers" };
		expect(shouldStationPlay(before, "ATC")).toBe(true);
		expect(shouldStationPlay(after, "ATC")).toBe(false);
		expect(shouldStationPlay(after, "Rutgers")).toBe(true);
	});
});

describe("sanitizeStationKeys", () => {
	it("keeps only string entries (drops legacy numeric ids)", () => {
		expect(sanitizeStationKeys(["ATC", 5, "Rutgers", null, 7])).toEqual(["ATC", "Rutgers"]);
	});
	it("returns [] for non-arrays / undefined", () => {
		expect(sanitizeStationKeys(undefined)).toEqual([]);
		expect(sanitizeStationKeys(42)).toEqual([]);
	});
});

describe("sanitizeActiveStation", () => {
	it("returns the string as-is, or '' for non-strings (legacy numeric id)", () => {
		expect(sanitizeActiveStation("ATC")).toBe("ATC");
		expect(sanitizeActiveStation(7)).toBe("");
		expect(sanitizeActiveStation(undefined)).toBe("");
	});
});

describe("sanitizeItemIds", () => {
	it("keeps only finite numbers (drops strings, NaN, Infinity)", () => {
		expect(sanitizeItemIds([1, "2", 3, Number.NaN, Number.POSITIVE_INFINITY, 4])).toEqual([1, 3, 4]);
	});
	it("returns [] for non-arrays / undefined", () => {
		expect(sanitizeItemIds(undefined)).toEqual([]);
		expect(sanitizeItemIds("nope")).toEqual([]);
	});
});
