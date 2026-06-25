import { describe, expect, it } from "vitest";
import {
	sanitizeActiveStation,
	sanitizeItemIds,
	sanitizeStationKeys,
	shouldStationPlay,
} from "./radioPlayback";

describe("shouldStationPlay", () => {
	it("single-station mode: only the active station may play", () => {
		const sel = { scannerMode: false, activeStation: "ATC", selectedStations: ["X", "Y"] };
		expect(shouldStationPlay(sel, "ATC")).toBe(true);
		expect(shouldStationPlay(sel, "X")).toBe(false); // selectedStations ignored off-scan
		expect(shouldStationPlay(sel, "Nope")).toBe(false);
	});

	it("switching the active station silences the previous one", () => {
		const before = { scannerMode: false, activeStation: "ATC", selectedStations: [] };
		const after = { scannerMode: false, activeStation: "Rutgers", selectedStations: [] };
		expect(shouldStationPlay(before, "ATC")).toBe(true);
		expect(shouldStationPlay(after, "ATC")).toBe(false);
		expect(shouldStationPlay(after, "Rutgers")).toBe(true);
	});

	it("scan mode: every selected station may play, others may not", () => {
		const sel = { scannerMode: true, activeStation: "ATC", selectedStations: ["Rutgers", "Newark"] };
		expect(shouldStationPlay(sel, "Rutgers")).toBe(true);
		expect(shouldStationPlay(sel, "Newark")).toBe(true);
		expect(shouldStationPlay(sel, "ATC")).toBe(false); // activeStation ignored in scan
		expect(shouldStationPlay(sel, "Nope")).toBe(false);
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
