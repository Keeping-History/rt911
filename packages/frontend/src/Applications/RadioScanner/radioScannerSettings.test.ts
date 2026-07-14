import { describe, expect, it } from "vitest";
import {
	DEFAULT_RADIO_SCANNER_SETTINGS,
	nextVizMode,
	radioScannerSetSettings,
	readRadioScannerSettings,
} from "./radioScannerSettings";

describe("readRadioScannerSettings", () => {
	it("returns defaults for undefined app data", () => {
		expect(readRadioScannerSettings(undefined)).toEqual(
			DEFAULT_RADIO_SCANNER_SETTINGS,
		);
	});

	it("returns defaults when data has no settings key", () => {
		expect(readRadioScannerSettings({ activeStation: "ATC" })).toEqual(
			DEFAULT_RADIO_SCANNER_SETTINGS,
		);
	});

	it("returns stored settings when every field is valid", () => {
		const stored = {
			vizMode: "Bars",
			useThemeColors: false,
			colorBright: 0xff0000,
			colorDim: 0x330000,
			maxVolume: 40,
		};
		expect(readRadioScannerSettings({ settings: stored })).toEqual(stored);
	});

	it("falls back per field on invalid values", () => {
		const out = readRadioScannerSettings({
			settings: {
				vizMode: "Lasers",          // not a viz mode
				useThemeColors: "yes",      // not a boolean
				colorBright: 0x1000000,     // > 0xffffff
				colorDim: 0x112233,         // valid — must survive
				maxVolume: 101,             // > 100
			},
		});
		expect(out).toEqual({
			...DEFAULT_RADIO_SCANNER_SETTINGS,
			colorDim: 0x112233,
		});
	});

	it("rejects non-integer and negative colors", () => {
		const out = readRadioScannerSettings({
			settings: { colorBright: 1.5, colorDim: -1 },
		});
		expect(out.colorBright).toBe(DEFAULT_RADIO_SCANNER_SETTINGS.colorBright);
		expect(out.colorDim).toBe(DEFAULT_RADIO_SCANNER_SETTINGS.colorDim);
	});

	it("rejects out-of-range and non-integer maxVolume", () => {
		for (const bad of [-1, 101, 1.5, "50", null]) {
			const out = readRadioScannerSettings({ settings: { maxVolume: bad } });
			expect(out.maxVolume).toBe(DEFAULT_RADIO_SCANNER_SETTINGS.maxVolume);
		}
		expect(
			readRadioScannerSettings({ settings: { maxVolume: 0 } }).maxVolume,
		).toBe(0);
		expect(
			readRadioScannerSettings({ settings: { maxVolume: 100 } }).maxVolume,
		).toBe(100);
	});
});

describe("radioScannerSetSettings", () => {
	it("builds the persistence action", () => {
		expect(radioScannerSetSettings(DEFAULT_RADIO_SCANNER_SETTINGS)).toEqual({
			type: "ClassicyAppRadioScannerSetSettings",
			settings: DEFAULT_RADIO_SCANNER_SETTINGS,
		});
	});
});

describe("nextVizMode", () => {
	it("cycles Bars → Spectrum → Radial → Wave → Bars", () => {
		expect(nextVizMode("Bars")).toBe("Spectrum");
		expect(nextVizMode("Spectrum")).toBe("Radial");
		expect(nextVizMode("Radial")).toBe("Wave");
		expect(nextVizMode("Wave")).toBe("Bars");
	});
});
