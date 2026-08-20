import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";
import type { LoopSpeed, LoopWindowMinutes } from "./loopClock";
import { type CameraMode, DEFAULT_CAMERA_MODE, normalizeCameraMode } from "./flightCamera";
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
	buildingHeroColorLight: number;
	buildingHeroColorDark: number;
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
	// Anonymous radar traffic (RDR-… ids, #263): opt-in "Other" layer — the
	// extra stream is subscribed only while this is on.
	anonTraffic: boolean;
	// Camera-follow framing for the tracked flights (track/cockpit/highlight).
	// Persisted as a preference; the follow on/off toggle itself is ephemeral
	// (it needs a live selection), so it lives in FlightTracker, not here.
	cameraMode: CameraMode;
}

export const DEFAULT_FLIGHT_MAP_SETTINGS: FlightMapSettings = {
	mapStyle: "classic",
	darkMap: false,
	pinColorLight: 0x00ffff, // cyan dot, legible on paper
	pinColorDark: 0xffd700, // gold radar-scope accent, legible on slate
	notablePinColorLight: 0xc0202a, // the original notable highlight
	notablePinColorDark: 0xff4d4d, // brightened red so it reads on slate
	observerPinColorLight: 0x0f766e, // blue-green (teal) for witness aircraft
	observerPinColorDark: 0x2dd4bf, // brightened teal so it reads on slate
	buildingHeroColorLight: 0xb0a48c, // warm stone, distinct from the neutral mass
	buildingHeroColorDark: 0xc7b8a0, // brightened stone for the slate map
	radarSweep: true,
	trailMultiplier: 5,
	globe: false,
	cluster: false,
	threeD: false,
	terrain: true,
	anonTraffic: false,
	cameraMode: DEFAULT_CAMERA_MODE,
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
	return {
		...merged,
		mapStyle: normalizeBasemapStyle(merged.mapStyle),
		cameraMode: normalizeCameraMode(merged.cameraMode),
	};
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

// POI layer preferences (airport markers, etc.). A SEPARATE slice from
// mapSettings/loopSettings/filterSettings so the Layers… window's live toggles
// and the Settings dialog's Save never clobber each other's persisted state.
// `disabledLayers` (not enabled) is stored so a newly-added Directus layer
// defaults to visible with no migration.
export interface FlightPoiSettings {
	enabled: boolean;
	disabledLayers: string[];
	// Layers with clustering OFF (default: all layers cluster). Stored as the
	// exception so a new Directus layer clusters with no migration.
	unclusteredLayers: string[];
}

export const DEFAULT_FLIGHT_POI_SETTINGS: FlightPoiSettings = {
	enabled: true,
	disabledLayers: [],
	unclusteredLayers: [],
};

/** Persist the whole POI-settings object in one dispatch. */
export const flightTrackerSetPoiSettings = (
	poiSettings: FlightPoiSettings,
): ActionMessage => ({
	type: "ClassicyAppFlightTrackerSetPoiSettings",
	poiSettings,
});

/** Per-field fallback to defaults, so absent/partial stored state needs no migration. */
export const readFlightPoiSettings = (
	data: Record<string, unknown> | undefined,
): FlightPoiSettings => {
	const stored =
		(data?.poiSettings as Partial<FlightPoiSettings> | undefined) ?? {};
	return { ...DEFAULT_FLIGHT_POI_SETTINGS, ...stored };
};

/**
 * Desaturate a packed color toward its own grey by `amount` (0-1), keeping
 * lightness. Anonymous radar traffic (#263) renders at half the saturation of
 * the identified pins so it reads as background texture without becoming a
 * second hue to learn — and it follows automatically when the pin color is
 * changed in Settings.
 */
export const desaturate = (color: number, amount: number): number => {
	const r = (color >> 16) & 255;
	const g = (color >> 8) & 255;
	const b = color & 255;
	// Rec. 601 luma keeps the greyed color at the same perceived lightness.
	const grey = 0.299 * r + 0.587 * g + 0.114 * b;
	const mix = (c: number) => Math.round(c + (grey - c) * amount);
	return (mix(r) << 16) | (mix(g) << 8) | mix(b);
};

/** Fraction of saturation removed from the pin color for anonymous traffic. */
export const ANON_DESATURATION = 0.5;

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
		case "ClassicyAppFlightTrackerSetPoiSettings":
			apps[appId].data = { ...appData, poiSettings: action.poiSettings };
			return ds;
		default:
			return ds;
	}
};

const FLIGHT_TRACKER_DESCRIPTION =
	"Radar-reconstructed flight map for September 11, 2001 — tracks, loops, and airport POIs.";

export const FlightTrackerDataSchema = z.looseObject({
	mapSettings: z
		.looseObject({
			mapStyle: z.string().describe("Basemap display mode id (classic/radar/satellite)."),
			darkMap: z.boolean().describe("Dark basemap variant; orthogonal to mapStyle."),
			pinColorLight: z.number().describe("Aircraft pin color on light basemaps, packed 0xRRGGBB."),
			pinColorDark: z.number().describe("Aircraft pin color on dark basemaps, packed 0xRRGGBB."),
			notablePinColorLight: z.number().describe("Notable-flight pin color on light basemaps, packed 0xRRGGBB."),
			notablePinColorDark: z.number().describe("Notable-flight pin color on dark basemaps, packed 0xRRGGBB."),
			observerPinColorLight: z.number().describe("Witness-aircraft pin color on light basemaps, packed 0xRRGGBB."),
			observerPinColorDark: z.number().describe("Witness-aircraft pin color on dark basemaps, packed 0xRRGGBB."),
			buildingHeroColorLight: z.number().describe("Hero-building color on light basemaps, packed 0xRRGGBB."),
			buildingHeroColorDark: z.number().describe("Hero-building color on dark basemaps, packed 0xRRGGBB."),
			radarSweep: z.boolean().describe("Whether the radar sweep animation is shown."),
			trailMultiplier: z.number().describe("Comet-tail length as a multiple of base TRAIL_POINTS; 0 = off."),
			globe: z.boolean().describe("Globe projection toggle."),
			cluster: z.boolean().describe("Marker clustering toggle."),
			threeD: z.boolean().describe("3D buildings/extrusion toggle."),
			terrain: z.boolean().describe("Topographic relief (hillshade + 3D ground mesh)."),
			anonTraffic: z.boolean().describe("Show anonymous radar traffic (RDR-… ids) as an opt-in layer."),
			cameraMode: z.string().describe("Camera-follow framing for tracked flights (track/cockpit/highlight)."),
		})
		.partial()
		.optional()
		.describe("Map appearance and layer-toggle preferences (the Settings dialog)."),
	loopSettings: z
		.looseObject({
			enabled: z.boolean().describe("Whether radar-loop replay mode is on."),
			windowMinutes: z.union([z.literal(30), z.literal(90)]).describe("Replay window length in minutes."),
			speed: z
				.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100), z.literal(500)])
				.describe("Replay speed multiplier."),
		})
		.partial()
		.optional()
		.describe("Loop-strip playback preferences; ephemeral playhead state is never persisted."),
	filterSettings: z
		.looseObject({
			flight: z.string().describe("Flight-number criterion; \"\" = any."),
			tail: z.string().describe("Tail-number criterion; \"\" = any."),
			carrier: z.string().describe("Carrier criterion; \"\" = any."),
			origin: z.string().describe("Origin-airport criterion; \"\" = any."),
			dest: z.string().describe("Destination-airport criterion; \"\" = any."),
			flights: z.array(z.string()).describe("Explicit flight list from an area selection; [] = inactive."),
		})
		.partial()
		.optional()
		.describe("The Filter Flights window's criteria; ANDed together."),
	poiSettings: z
		.looseObject({
			enabled: z.boolean().describe("Master POI-layer toggle."),
			disabledLayers: z.array(z.string()).describe("POI layers turned off (blacklist: new layers default visible)."),
			unclusteredLayers: z.array(z.string()).describe("POI layers with clustering off (default: all cluster)."),
		})
		.partial()
		.optional()
		.describe("Airport/POI marker-layer preferences (the Layers… window)."),
	// Written by flightTrackerCommands.ts (secondary module, handoff §3 convention):
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each focus command applies exactly once."),
			kind: z.literal("focus").describe("Command kind; only \"focus\" exists."),
			callsign: z.string().describe("Callsign to select, e.g. \"AA11\"."),
		})
		.optional()
		.describe("Pending one-shot remote focus command."),
	focusedFlight: z
		.string()
		.nullable()
		.optional()
		.describe("Currently selected flight's callsign, published for playlist locked-focus."),
});

export type FlightTrackerData = z.infer<typeof FlightTrackerDataSchema>;

registerApp({
	id: appId,
	description: FLIGHT_TRACKER_DESCRIPTION,
	prefix: "ClassicyAppFlightTracker",
	handler: classicyFlightTrackerEventHandler,
	actions: {
		ClassicyAppFlightTrackerSetMapSettings: {
			description: "Persist the whole map-appearance settings object.",
			params: z.object({ mapSettings: z.record(z.string(), z.unknown()).describe("Full FlightMapSettings object.") }),
		},
		ClassicyAppFlightTrackerSetLoopSettings: {
			description: "Persist the whole loop-playback settings object.",
			params: z.object({ loopSettings: z.record(z.string(), z.unknown()).describe("Full FlightLoopSettings object.") }),
		},
		ClassicyAppFlightTrackerSetFilterSettings: {
			description: "Persist the whole flight-filter criteria object.",
			params: z.object({ filterSettings: z.record(z.string(), z.unknown()).describe("Full FlightFilter object.") }),
		},
		ClassicyAppFlightTrackerSetPoiSettings: {
			description: "Persist the whole POI-layer settings object.",
			params: z.object({ poiSettings: z.record(z.string(), z.unknown()).describe("Full FlightPoiSettings object.") }),
		},
	},
	state: FlightTrackerDataSchema,
});
