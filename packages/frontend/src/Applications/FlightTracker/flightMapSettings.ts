import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";
import type { LoopSpeed, LoopWindowMinutes } from "./loopClock";
import { EMPTY_FLIGHT_FILTER, type FlightFilter } from "./flightFilter";
import {
	type BasemapStyleId,
	normalizeBasemapStyle,
} from "../../lib/basemap/basemapStyles";

export const FLIGHT_TRACKER_APP_ID = "FlightTracker.app";
const appId = FLIGHT_TRACKER_APP_ID;

// Colors are packed 0xRRGGBB ints — ClassicyColorPicker's native format. They
// stay ints everywhere except the FlightMap prop boundary (see intToHex).
// Pin colors are stored per basemap theme: a single color can't stay legible on
// both the paper-light and slate-dark grounds, so light/dark are independent and
// FlightTracker picks the pair matching the style's effective tone (see
// `effectiveTone` in lib/basemap) — radar is always dark-toned regardless of the flag.
export interface FlightMapSettings {
	// Basemap display mode; orthogonal to darkMap (see lib/basemap).
	mapStyle: BasemapStyleId;
	darkMap: boolean;
	pinColorLight: number;
	pinColorDark: number;
	notablePinColorLight: number;
	notablePinColorDark: number;
	observerPinColorLight: number;
	observerPinColorDark: number;
	radarSweep: boolean;
	// Comet-tail length as a multiple of the base TRAIL_POINTS; 0 = tails off.
	trailMultiplier: number;
	// MapControls toolbar toggles (issues #218/#222/#223). Camera/projection
	// preferences, so they persist like the appearance settings above.
	globe: boolean;
	cluster: boolean;
	threeD: boolean;
	// Topographic relief (hillshade + 3D ground mesh) — one switch for both.
	terrain: boolean;
}

export const DEFAULT_FLIGHT_MAP_SETTINGS: FlightMapSettings = {
	mapStyle: "classic",
	darkMap: false,
	pinColorLight: 0x3a3a3a, // the original dark-gray dot, legible on paper
	pinColorDark: 0xffd700, // gold radar-scope accent, legible on slate
	notablePinColorLight: 0xc0202a, // the original notable highlight
	notablePinColorDark: 0xff4d4d, // brightened red so it reads on slate
	observerPinColorLight: 0x0f766e, // blue-green (teal) for witness aircraft
	observerPinColorDark: 0x2dd4bf, // brightened teal so it reads on slate
	radarSweep: true,
	trailMultiplier: 5,
	globe: false,
	cluster: false,
	threeD: false,
	terrain: true,
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
	const merged = { ...DEFAULT_FLIGHT_MAP_SETTINGS, ...stored };
	return { ...merged, mapStyle: normalizeBasemapStyle(merged.mapStyle) };
};

// Loop playback preferences. Kept separate from mapSettings so the Settings
// dialog (map appearance) and the loop strip persist independently — neither
// UI's save clobbers the other. Ephemeral playback state (clock anchors,
// scrubbing, paused, playhead) is NOT persisted; only the user's choices are.
export interface FlightLoopSettings {
	enabled: boolean;
	windowMinutes: LoopWindowMinutes;
	speed: LoopSpeed;
}

export const DEFAULT_FLIGHT_LOOP_SETTINGS: FlightLoopSettings = {
	enabled: true, // the radar loop is the app's primary view
	windowMinutes: 30,
	speed: 10,
};

/** Persist the whole loop-settings object in one dispatch. */
export const flightTrackerSetLoopSettings = (
	loopSettings: FlightLoopSettings,
): ActionMessage => ({
	type: "ClassicyAppFlightTrackerSetLoopSettings",
	loopSettings,
});

/** Per-field fallback to defaults, so absent/partial stored state needs no migration. */
export const readFlightLoopSettings = (
	data: Record<string, unknown> | undefined,
): FlightLoopSettings => {
	const stored =
		(data?.loopSettings as Partial<FlightLoopSettings> | undefined) ?? {};
	return { ...DEFAULT_FLIGHT_LOOP_SETTINGS, ...stored };
};

// The Filter Flights window's criteria (issue #188). Persisted like map/loop
// settings so a filter survives refresh; the status bar's "filtered" cue and
// the button's "(on)" label keep a persisted filter from being mysterious.
/** Persist the whole filter object in one dispatch. */
export const flightTrackerSetFilterSettings = (
	filterSettings: FlightFilter,
): ActionMessage => ({
	type: "ClassicyAppFlightTrackerSetFilterSettings",
	filterSettings,
});

/** Per-field fallback to "any", so absent/partial stored state needs no migration. */
export const readFlightFilterSettings = (
	data: Record<string, unknown> | undefined,
): FlightFilter => {
	const stored =
		(data?.filterSettings as Partial<FlightFilter> | undefined) ?? {};
	return { ...EMPTY_FLIGHT_FILTER, ...stored };
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
		case "ClassicyAppFlightTrackerSetLoopSettings":
			apps[appId].data = { ...appData, loopSettings: action.loopSettings };
			return ds;
		case "ClassicyAppFlightTrackerSetFilterSettings":
			apps[appId].data = { ...appData, filterSettings: action.filterSettings };
			return ds;
		default:
			return ds;
	}
};

registerAppEventHandler(
	"ClassicyAppFlightTracker",
	classicyFlightTrackerEventHandler,
);
