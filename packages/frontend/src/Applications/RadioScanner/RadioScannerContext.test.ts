import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import { classicyRadioScannerEventHandler } from "./RadioScannerContext";

function storeWithApp(data: Record<string, unknown> = {}): ClassicyStore {
	return {
		System: {
			Manager: {
				Applications: { apps: { "RadioScanner.app": { data } } },
			},
		},
	} as unknown as ClassicyStore;
}

describe("classicyRadioScannerEventHandler", () => {
	it("persists activeStation, mutedItems, and showWaveform", () => {
		const ds = storeWithApp();
		const out = classicyRadioScannerEventHandler(ds, {
			type: "ClassicyAppRadioScannerSetState",
			activeStation: "ATC",
			mutedItems: [101, 102],
			showWaveform: false,
		});
		const data = out.System.Manager.Applications.apps["RadioScanner.app"].data;
		expect(data).toMatchObject({
			activeStation: "ATC",
			mutedItems: [101, 102],
			showWaveform: false,
		});
	});

	it("does not persist scanner-mode fields", () => {
		const ds = storeWithApp();
		const out = classicyRadioScannerEventHandler(ds, {
			type: "ClassicyAppRadioScannerSetState",
			activeStation: "ATC",
			scannerMode: true,
			selectedStations: ["ATC"],
			mutedStations: ["Rutgers"],
			mutedItems: [],
			showWaveform: true,
		});
		const data = out.System.Manager.Applications.apps["RadioScanner.app"].data;
		expect(data).not.toHaveProperty("scannerMode");
		expect(data).not.toHaveProperty("selectedStations");
		expect(data).not.toHaveProperty("mutedStations");
	});

	it("ignores unrelated actions and missing app", () => {
		const ds = storeWithApp({ showWaveform: true });
		expect(classicyRadioScannerEventHandler(ds, { type: "SomethingElse" })).toBe(ds);
		const empty = { System: { Manager: { Applications: { apps: {} } } } } as unknown as ClassicyStore;
		expect(classicyRadioScannerEventHandler(empty, { type: "ClassicyAppRadioScannerSetState" })).toBe(empty);
	});
});
