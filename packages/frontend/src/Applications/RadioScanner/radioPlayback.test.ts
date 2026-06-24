import { describe, expect, it } from "vitest";
import { shouldStationPlay } from "./radioPlayback";

describe("shouldStationPlay", () => {
	it("single-station mode: only the active station may play", () => {
		const sel = { scannerMode: false, activeStation: 7, selectedStations: [1, 2] };
		expect(shouldStationPlay(sel, 7)).toBe(true);
		expect(shouldStationPlay(sel, 1)).toBe(false); // selectedStations ignored off-scan
		expect(shouldStationPlay(sel, 99)).toBe(false);
	});

	it("switching the active station silences the previous one (the bug)", () => {
		const before = { scannerMode: false, activeStation: 3, selectedStations: [] };
		const after = { scannerMode: false, activeStation: 5, selectedStations: [] };
		// Station 3 played before; after switching to 5 it must no longer be allowed.
		expect(shouldStationPlay(before, 3)).toBe(true);
		expect(shouldStationPlay(after, 3)).toBe(false);
		expect(shouldStationPlay(after, 5)).toBe(true);
	});

	it("scan mode: every selected station may play, others may not", () => {
		const sel = { scannerMode: true, activeStation: 7, selectedStations: [2, 4] };
		expect(shouldStationPlay(sel, 2)).toBe(true);
		expect(shouldStationPlay(sel, 4)).toBe(true);
		expect(shouldStationPlay(sel, 7)).toBe(false); // activeStation ignored in scan
		expect(shouldStationPlay(sel, 9)).toBe(false);
	});
});
