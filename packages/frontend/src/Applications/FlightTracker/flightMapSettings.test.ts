import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_FLIGHT_LOOP_SETTINGS,
	DEFAULT_FLIGHT_MAP_SETTINGS,
	classicyFlightTrackerEventHandler,
	flightTrackerSetLoopSettings,
	flightTrackerSetMapSettings,
	flightTrackerSetFilterSettings,
	intToHex,
	readFlightLoopSettings,
	readFlightMapSettings,
	readFlightFilterSettings,
} from "./flightMapSettings";
import { EMPTY_FLIGHT_FILTER } from "./flightFilter";

function storeWithApp(data: Record<string, unknown> = {}): ClassicyStore {
	return {
		System: {
			Manager: {
				Applications: { apps: { "FlightTracker.app": { data } } },
			},
		},
	} as unknown as ClassicyStore;
}

describe("classicyFlightTrackerEventHandler", () => {
	it("persists mapSettings from a SetMapSettings action", () => {
		const settings = { mapStyle: "radar" as const, darkMap: true, pinColorLight: 0x112233, pinColorDark: 0x778899, notablePinColorLight: 0x445566, notablePinColorDark: 0xaabbcc, radarSweep: false, trailMultiplier: 2, globe: true, cluster: false, threeD: true, terrain: true };
		const out = classicyFlightTrackerEventHandler(
			storeWithApp(),
			flightTrackerSetMapSettings(settings),
		);
		expect(
			out.System.Manager.Applications.apps["FlightTracker.app"].data,
		).toMatchObject({ mapSettings: settings });
	});

	it("preserves unrelated app data when writing settings", () => {
		const out = classicyFlightTrackerEventHandler(
			storeWithApp({ somethingElse: 7 }),
			flightTrackerSetMapSettings(DEFAULT_FLIGHT_MAP_SETTINGS),
		);
		expect(
			out.System.Manager.Applications.apps["FlightTracker.app"].data,
		).toMatchObject({ somethingElse: 7, mapSettings: DEFAULT_FLIGHT_MAP_SETTINGS });
	});

	it("returns the store untouched when the app entry is missing", () => {
		const ds = {
			System: { Manager: { Applications: { apps: {} } } },
		} as unknown as ClassicyStore;
		expect(
			classicyFlightTrackerEventHandler(
				ds,
				flightTrackerSetMapSettings(DEFAULT_FLIGHT_MAP_SETTINGS),
			),
		).toBe(ds);
	});

	it("persists loopSettings from a SetLoopSettings action without touching mapSettings", () => {
		const loopSettings = { enabled: false, windowMinutes: 90 as const, speed: 100 as const };
		const out = classicyFlightTrackerEventHandler(
			storeWithApp({ mapSettings: DEFAULT_FLIGHT_MAP_SETTINGS }),
			flightTrackerSetLoopSettings(loopSettings),
		);
		expect(
			out.System.Manager.Applications.apps["FlightTracker.app"].data,
		).toMatchObject({ mapSettings: DEFAULT_FLIGHT_MAP_SETTINGS, loopSettings });
	});
});

describe("readFlightMapSettings", () => {
	it("returns defaults when nothing is stored", () => {
		expect(readFlightMapSettings(undefined)).toEqual(DEFAULT_FLIGHT_MAP_SETTINGS);
		expect(readFlightMapSettings({})).toEqual(DEFAULT_FLIGHT_MAP_SETTINGS);
	});

	it("merges partial stored settings over defaults (no migration needed)", () => {
		expect(readFlightMapSettings({ mapSettings: { darkMap: true } })).toEqual({
			...DEFAULT_FLIGHT_MAP_SETTINGS,
			darkMap: true,
		});
	});

	it("defaults radarSweep to true, including for pre-radar persisted state", () => {
		expect(readFlightMapSettings(undefined).radarSweep).toBe(true);
		// State persisted before the radar feature existed lacks the field.
		expect(readFlightMapSettings({ mapSettings: { darkMap: true } }).radarSweep).toBe(true);
	});

	it("defaults trailMultiplier to 5, including for older persisted state", () => {
		expect(readFlightMapSettings(undefined).trailMultiplier).toBe(5);
		expect(readFlightMapSettings({ mapSettings: { darkMap: true } }).trailMultiplier).toBe(5);
	});

	it("defaults to independent light/dark pin colors that read on each ground", () => {
		const s = readFlightMapSettings(undefined);
		// Light map keeps the original dark-gray / red; dark map gets a lighter,
		// higher-contrast pair so pins don't vanish into the slate basemap.
		expect(s.pinColorLight).toBe(0x3a3a3a);
		expect(s.pinColorDark).toBe(0xffd700);
		expect(s.notablePinColorLight).toBe(0xc0202a);
		expect(s.notablePinColorDark).toBe(0xff4d4d);
		expect(s.pinColorDark).not.toBe(s.pinColorLight);
	});

	it("defaults mapStyle to classic and preserves a stored valid style", () => {
		expect(readFlightMapSettings(undefined).mapStyle).toBe("classic");
		expect(
			readFlightMapSettings({ mapSettings: { mapStyle: "satellite" } }).mapStyle,
		).toBe("satellite");
	});

	it("normalizes an unrecognized persisted mapStyle to classic", () => {
		expect(
			readFlightMapSettings({ mapSettings: { mapStyle: "sepia" } }).mapStyle,
		).toBe("classic");
	});

	it("defaults globe/cluster/threeD to false and reads stored values", () => {
		expect(readFlightMapSettings(undefined)).toMatchObject({
			globe: false,
			cluster: false,
			threeD: false,
		});
		// State persisted before these toolbar toggles existed lacks the fields.
		expect(
			readFlightMapSettings({ mapSettings: { globe: true, threeD: true } }),
		).toMatchObject({ globe: true, cluster: false, threeD: true });
	});

	it("defaults terrain on and honors a stored false", () => {
		expect(readFlightMapSettings(undefined).terrain).toBe(true);
		expect(readFlightMapSettings({ mapSettings: { terrain: false } }).terrain).toBe(false);
		// Pre-terrain stored state (no key at all) upgrades to the default.
		expect(readFlightMapSettings({ mapSettings: { globe: true } }).terrain).toBe(true);
	});
});

describe("readFlightLoopSettings", () => {
	it("returns defaults (loop on, 30 min, 10×) when nothing is stored", () => {
		expect(readFlightLoopSettings(undefined)).toEqual(DEFAULT_FLIGHT_LOOP_SETTINGS);
		expect(readFlightLoopSettings({})).toEqual(DEFAULT_FLIGHT_LOOP_SETTINGS);
		expect(DEFAULT_FLIGHT_LOOP_SETTINGS).toEqual({
			enabled: true,
			windowMinutes: 30,
			speed: 10,
		});
	});

	it("merges partial stored loop settings over defaults (no migration needed)", () => {
		expect(readFlightLoopSettings({ loopSettings: { enabled: false } })).toEqual({
			...DEFAULT_FLIGHT_LOOP_SETTINGS,
			enabled: false,
		});
	});
});

describe("intToHex", () => {
	it("pads to six hex digits", () => {
		expect(intToHex(0x0000ff)).toBe("#0000ff");
	});
	it("formats the default pin colors", () => {
		expect(intToHex(0x3a3a3a)).toBe("#3a3a3a"); // pin light
		expect(intToHex(0xffd700)).toBe("#ffd700"); // pin dark
		expect(intToHex(0xc0202a)).toBe("#c0202a"); // notable light
		expect(intToHex(0xff4d4d)).toBe("#ff4d4d"); // notable dark
	});
});

describe("filter settings", () => {
	it("persists filterSettings from a SetFilterSettings action without touching other data", () => {
		const filterSettings = { flight: "", tail: "", carrier: "AA", origin: "BOS", dest: "", flights: [] };
		const out = classicyFlightTrackerEventHandler(
			storeWithApp({ mapSettings: { darkMap: true } }),
			flightTrackerSetFilterSettings(filterSettings),
		);
		expect(
			out.System.Manager.Applications.apps["FlightTracker.app"].data,
		).toMatchObject({ mapSettings: { darkMap: true }, filterSettings });
	});

	it("readFlightFilterSettings falls back per-field to the empty filter", () => {
		expect(readFlightFilterSettings(undefined)).toEqual(EMPTY_FLIGHT_FILTER);
		expect(readFlightFilterSettings({})).toEqual(EMPTY_FLIGHT_FILTER);
		expect(readFlightFilterSettings({ filterSettings: { carrier: "UA" } })).toEqual({
			// flights back-fills to [] for pre-#225 persisted state.
			flight: "", tail: "", carrier: "UA", origin: "", dest: "", flights: [],
		});
	});
});
