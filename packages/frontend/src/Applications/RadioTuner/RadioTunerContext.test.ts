import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	classicyRadioTunerEventHandler,
	radioTunerSetSettings,
	radioTunerTuneStation,
} from "./RadioTunerContext";
import type { RadioScannerSettings } from "../RadioScanner/radioScannerSettings";

function storeWithApp(data: Record<string, unknown> = {}): ClassicyStore {
	return {
		System: {
			Manager: {
				Applications: { apps: { "RadioTuner.app": { data } } },
			},
		},
	} as unknown as ClassicyStore;
}

describe("classicyRadioTunerEventHandler", () => {
	it("persists activeStation, mutedItems, and showWaveform", () => {
		const ds = storeWithApp();
		const out = classicyRadioTunerEventHandler(ds, {
			type: "ClassicyAppRadioTunerSetState",
			activeStation: "WCBS",
			mutedItems: [101],
			showWaveform: false,
		});
		const data = out.System.Manager.Applications.apps["RadioTuner.app"].data;
		expect(data).toMatchObject({
			activeStation: "WCBS",
			mutedItems: [101],
			showWaveform: false,
		});
	});

	it("ignores unrelated actions and missing app", () => {
		const ds = storeWithApp({ showWaveform: true });
		expect(classicyRadioTunerEventHandler(ds, { type: "SomethingElse" })).toBe(ds);
		const empty = { System: { Manager: { Applications: { apps: {} } } } } as unknown as ClassicyStore;
		expect(classicyRadioTunerEventHandler(empty, { type: "ClassicyAppRadioTunerSetState" })).toBe(empty);
	});
});

describe("classicyRadioTunerEventHandler settings", () => {
	const settings = {
		vizMode: "Bars",
		useThemeColors: false,
		colorBright: 0xff0000,
		colorDim: 0x330000,
	} as unknown as RadioScannerSettings;

	it("persists settings under data.settings", () => {
		const ds = storeWithApp();
		const out = classicyRadioTunerEventHandler(
			ds,
			radioTunerSetSettings(settings),
		);
		expect(
			out.System.Manager.Applications.apps["RadioTuner.app"].data,
		).toMatchObject({ settings });
	});

	it("SetSettings preserves SetState fields", () => {
		const ds = storeWithApp({ activeStation: "WINS", mutedItems: [7] });
		const out = classicyRadioTunerEventHandler(
			ds,
			radioTunerSetSettings(settings),
		);
		const data = out.System.Manager.Applications.apps["RadioTuner.app"].data;
		expect(data).toMatchObject({
			activeStation: "WINS",
			mutedItems: [7],
			settings,
		});
	});
});

describe("classicyRadioTunerEventHandler — remote tune command", () => {
	it("writes a seq-command with the station slug", () => {
		const ds = storeWithApp();
		const out = classicyRadioTunerEventHandler(ds, radioTunerTuneStation("wcbs"));
		expect(
			out.System.Manager.Applications.apps["RadioTuner.app"].data,
		).toMatchObject({ command: { seq: 1, kind: "tune", station: "wcbs" } });
	});

	it("increments seq monotonically across commands", () => {
		const ds = storeWithApp();
		classicyRadioTunerEventHandler(ds, radioTunerTuneStation("wcbs"));
		const out = classicyRadioTunerEventHandler(ds, radioTunerTuneStation("wins"));
		expect(
			out.System.Manager.Applications.apps["RadioTuner.app"].data,
		).toMatchObject({ command: { seq: 2, kind: "tune", station: "wins" } });
	});
});
