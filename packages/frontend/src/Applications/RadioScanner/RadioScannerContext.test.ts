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
	it("persists activeStation, scannerMode, selectedStations, mutedStations, mutedItems, showWaveform", () => {
		const ds = storeWithApp();
		const out = classicyRadioScannerEventHandler(ds, {
			type: "ClassicyAppRadioScannerSetState",
			activeStation: "ATC",
			scannerMode: true,
			selectedStations: ["ATC", "Rutgers"],
			mutedStations: ["Rutgers"],
			mutedItems: [101, 102],
			showWaveform: false,
		});
		const data = out.System.Manager.Applications.apps["RadioScanner.app"].data;
		expect(data).toMatchObject({
			activeStation: "ATC",
			scannerMode: true,
			selectedStations: ["ATC", "Rutgers"],
			mutedStations: ["Rutgers"],
			mutedItems: [101, 102],
			showWaveform: false,
		});
	});

	it("ignores unrelated actions and missing app", () => {
		const ds = storeWithApp({ scannerMode: true });
		expect(classicyRadioScannerEventHandler(ds, { type: "SomethingElse" })).toBe(ds);
		const empty = { System: { Manager: { Applications: { apps: {} } } } } as unknown as ClassicyStore;
		expect(classicyRadioScannerEventHandler(empty, { type: "ClassicyAppRadioScannerSetState" })).toBe(empty);
	});
});
