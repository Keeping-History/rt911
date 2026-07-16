import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import { classicyRadioScannerEventHandler, radioTuneStation } from "./RadioScannerContext";

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

describe("classicyRadioScannerEventHandler settings", () => {
	const settings = {
		vizMode: "Bars",
		useThemeColors: false,
		colorBright: 0xff0000,
		colorDim: 0x330000,
	};

	it("persists settings under data.settings", () => {
		const ds = storeWithApp();
		const out = classicyRadioScannerEventHandler(ds, {
			type: "ClassicyAppRadioScannerSetSettings",
			settings,
		});
		expect(
			out.System.Manager.Applications.apps["RadioScanner.app"].data,
		).toMatchObject({ settings });
	});

	it("SetState preserves previously stored settings", () => {
		const ds = storeWithApp({ settings });
		const out = classicyRadioScannerEventHandler(ds, {
			type: "ClassicyAppRadioScannerSetState",
			activeStation: "ATC",
			mutedItems: [],
			showWaveform: true,
		});
		const data =
			out.System.Manager.Applications.apps["RadioScanner.app"].data;
		expect(data).toMatchObject({ activeStation: "ATC", settings });
	});

	it("SetSettings preserves SetState fields", () => {
		const ds = storeWithApp({ activeStation: "WINS", mutedItems: [7] });
		const out = classicyRadioScannerEventHandler(ds, {
			type: "ClassicyAppRadioScannerSetSettings",
			settings,
		});
		const data =
			out.System.Manager.Applications.apps["RadioScanner.app"].data;
		expect(data).toMatchObject({
			activeStation: "WINS",
			mutedItems: [7],
			settings,
		});
	});
});

describe("classicyRadioScannerEventHandler — remote tune command", () => {
	it("writes a seq-command with the station slug", () => {
		const ds = storeWithApp();
		const out = classicyRadioScannerEventHandler(ds, radioTuneStation("wnyc"));
		expect(
			out.System.Manager.Applications.apps["RadioScanner.app"].data,
		).toMatchObject({ command: { seq: 1, kind: "tune", station: "wnyc" } });
	});

	it("increments seq monotonically across commands", () => {
		const ds = storeWithApp();
		classicyRadioScannerEventHandler(ds, radioTuneStation("wnyc"));
		const out = classicyRadioScannerEventHandler(ds, radioTuneStation("wabc"));
		expect(
			out.System.Manager.Applications.apps["RadioScanner.app"].data,
		).toMatchObject({ command: { seq: 2, kind: "tune", station: "wabc" } });
	});
});
