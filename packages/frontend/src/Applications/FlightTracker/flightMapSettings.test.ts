import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_FLIGHT_MAP_SETTINGS,
	classicyFlightTrackerEventHandler,
	flightTrackerSetMapSettings,
	intToHex,
	readFlightMapSettings,
} from "./flightMapSettings";

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
		const settings = { darkMap: true, pinColor: 0x112233, notablePinColor: 0x445566 };
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
});

describe("intToHex", () => {
	it("pads to six hex digits", () => {
		expect(intToHex(0x0000ff)).toBe("#0000ff");
	});
	it("formats the default pin colors", () => {
		expect(intToHex(0x3a3a3a)).toBe("#3a3a3a");
		expect(intToHex(0xc0202a)).toBe("#c0202a");
	});
});
