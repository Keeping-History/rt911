import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";

export const FLIGHT_TRACKER_APP_ID = "FlightTracker.app";
const appId = FLIGHT_TRACKER_APP_ID;

// Colors are packed 0xRRGGBB ints — ClassicyColorPicker's native format. They
// stay ints everywhere except the FlightMap prop boundary (see intToHex).
export interface FlightMapSettings {
	darkMap: boolean;
	pinColor: number;
	notablePinColor: number;
	radarSweep: boolean;
	// Comet-tail length as a multiple of the base TRAIL_POINTS; 0 = tails off.
	trailMultiplier: number;
}

export const DEFAULT_FLIGHT_MAP_SETTINGS: FlightMapSettings = {
	darkMap: false,
	pinColor: 0x3a3a3a, // the original hardcoded dot color
	notablePinColor: 0xc0202a, // the original notable highlight
	radarSweep: true,
	trailMultiplier: 1,
};

/** Persist the whole map-settings object in one dispatch. */
export const flightTrackerSetMapSettings = (
	mapSettings: FlightMapSettings,
): ActionMessage => ({
	type: "ClassicyAppFlightTrackerSetMapSettings",
	mapSettings,
});

/** Per-field fallback to defaults, so absent/partial stored state needs no migration. */
export const readFlightMapSettings = (
	data: Record<string, unknown> | undefined,
): FlightMapSettings => {
	const stored =
		(data?.mapSettings as Partial<FlightMapSettings> | undefined) ?? {};
	return { ...DEFAULT_FLIGHT_MAP_SETTINGS, ...stored };
};

/** Packed int → CSS hex; the single place the two color formats meet. */
export const intToHex = (color: number): string =>
	`#${color.toString(16).padStart(6, "0")}`;

export const classicyFlightTrackerEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	const appData = ds.System.Manager.Applications.apps[appId].data ?? {};
	const apps = ds.System.Manager.Applications.apps;

	switch (action.type) {
		case "ClassicyAppFlightTrackerSetMapSettings":
			apps[appId].data = { ...appData, mapSettings: action.mapSettings };
			return ds;
		default:
			return ds;
	}
};

registerAppEventHandler(
	"ClassicyAppFlightTracker",
	classicyFlightTrackerEventHandler,
);
