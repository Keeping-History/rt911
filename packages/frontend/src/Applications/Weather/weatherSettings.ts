import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";
import {
	type BasemapStyleId,
	normalizeBasemapStyle,
} from "../../lib/basemap/basemapStyles";

export const WEATHER_APP_ID = "Weather.app";
const appId = WEATHER_APP_ID;

// Radar frames are on a 5-minute cadence, so useful speeds are far higher than
// FlightTracker's per-minute flight data: 600/1800/3600× ≈ 2/6/12 frames per
// second of wall time.
export const WEATHER_LOOP_SPEEDS = [600, 1800, 3600] as const;
export type WeatherLoopSpeed = (typeof WEATHER_LOOP_SPEEDS)[number];

export const WEATHER_SPEED_LABELS: Record<WeatherLoopSpeed, string> = {
	600: "600×",
	1800: "1800×",
	3600: "3600×",
};

export type WeatherLoopWindowHours = 1 | 3 | 6 | 12;

// Loop playback preferences. Ephemeral playback state (clock anchors,
// scrubbing, paused, playhead) is NOT persisted; only the user's choices are —
// same split as FlightTracker's flightMapSettings.ts.
export interface WeatherLoopSettings {
	enabled: boolean;
	windowHours: WeatherLoopWindowHours;
	speed: WeatherLoopSpeed;
}

export const DEFAULT_WEATHER_LOOP_SETTINGS: WeatherLoopSettings = {
	enabled: false, // live conditions are the app's primary view
	windowHours: 3,
	speed: 1800,
};

/** Persist the whole loop-settings object in one dispatch. */
export const weatherSetLoopSettings = (
	loopSettings: WeatherLoopSettings,
): ActionMessage => ({
	type: "ClassicyAppWeatherSetLoopSettings",
	loopSettings,
});

/** Per-field fallback to defaults, so absent/partial stored state needs no migration. */
export const readWeatherLoopSettings = (
	data: Record<string, unknown> | undefined,
): WeatherLoopSettings => {
	const stored =
		(data?.loopSettings as Partial<WeatherLoopSettings> | undefined) ?? {};
	return { ...DEFAULT_WEATHER_LOOP_SETTINGS, ...stored };
};

// Map appearance (shared basemap styles; see lib/basemap). Kept separate from
// loopSettings so the View menu's style items and the loop strip persist
// independently — neither write clobbers the other.
export interface WeatherMapSettings {
	mapStyle: BasemapStyleId;
	darkMap: boolean;
}

export const DEFAULT_WEATHER_MAP_SETTINGS: WeatherMapSettings = {
	mapStyle: "classic",
	darkMap: false,
};

/** Persist the whole map-settings object in one dispatch. */
export const weatherSetMapSettings = (
	mapSettings: WeatherMapSettings,
): ActionMessage => ({
	type: "ClassicyAppWeatherSetMapSettings",
	mapSettings,
});

/** Per-field fallback to defaults; unknown stored styles normalize to classic. */
export const readWeatherMapSettings = (
	data: Record<string, unknown> | undefined,
): WeatherMapSettings => {
	const stored =
		(data?.mapSettings as Partial<WeatherMapSettings> | undefined) ?? {};
	const merged = { ...DEFAULT_WEATHER_MAP_SETTINGS, ...stored };
	return { ...merged, mapStyle: normalizeBasemapStyle(merged.mapStyle) };
};

export const classicyWeatherEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	const appData = ds.System.Manager.Applications.apps[appId].data ?? {};
	const apps = ds.System.Manager.Applications.apps;

	switch (action.type) {
		case "ClassicyAppWeatherSetLoopSettings":
			apps[appId].data = { ...appData, loopSettings: action.loopSettings };
			return ds;
		case "ClassicyAppWeatherSetMapSettings":
			apps[appId].data = { ...appData, mapSettings: action.mapSettings };
			return ds;
		default:
			return ds;
	}
};

registerAppEventHandler("ClassicyAppWeather", classicyWeatherEventHandler);
