import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";

// User-facing basemap styles, orthogonal to the Dark Map toggle: classic is
// the original paper/slate vector look, radar a CRT phosphor scope, satellite
// period-correct NASA imagery (Blue Marble day / City Lights night — both
// built from ~2001 data; see scripts/build-satellite-basemap.md).
export type BasemapStyleId = "classic" | "radar" | "satellite";
export type BasemapTone = "light" | "dark";

export interface BasemapUrls {
	vector: string;
	satelliteDay: string;
	satelliteNight: string;
}

// Module-scope so the object identity is stable — FlightMap/WeatherMap key
// their create-once effect on this prop.
export const BASEMAP_URLS: BasemapUrls = {
	vector:
		(import.meta.env.VITE_FLIGHT_BASEMAP_URL as string | undefined) ??
		// World coverage (issue #220) so globe mode/panning never hit a tile
		// cliff; na-basemap.pmtiles stays hosted as the rollback.
		"https://files.911realtime.org/maps/world-basemap.pmtiles",
	satelliteDay:
		(import.meta.env.VITE_SATELLITE_DAY_BASEMAP_URL as string | undefined) ??
		"https://files.911realtime.org/maps/na-satellite-day.pmtiles",
	satelliteNight:
		(import.meta.env.VITE_SATELLITE_NIGHT_BASEMAP_URL as string | undefined) ??
		"https://files.911realtime.org/maps/na-satellite-night.pmtiles",
};

/** Persisted-state safety: anything unrecognized renders as classic. */
export function normalizeBasemapStyle(value: unknown): BasemapStyleId {
	return value === "radar" || value === "satellite" ? value : "classic";
}

// Which pin-color bucket / trail color applies. A radar scope is inherently a
// dark display, so it ignores the Dark Map toggle (the toggle is remembered
// and applies the moment the user switches styles).
export function effectiveTone(mapStyle: BasemapStyleId, darkMap: boolean): BasemapTone {
	if (mapStyle === "radar") return "dark";
	return darkMap ? "dark" : "light";
}

export interface BasemapPalette {
	background: string;
	land: string;
	lakes: string;
	countries: string;
	states: string;
}

const CLASSIC_LIGHT: BasemapPalette = {
	background: "#efe9dd",
	land: "#e3ddcf",
	lakes: "#d7d3c6",
	countries: "#8a8574",
	states: "#b3ad9c",
};
const CLASSIC_DARK: BasemapPalette = {
	background: "#1c1c22",
	land: "#26262e",
	lakes: "#16161c",
	countries: "#6f6f7e",
	states: "#44444f",
};
// CRT phosphor: near-black green ground, dim land fill, brighter borders.
const RADAR: BasemapPalette = {
	background: "#041004",
	land: "#0b1d0b",
	lakes: "#020c02",
	countries: "#2f9e4f",
	states: "#1e6434",
};
// land/lakes are hidden in satellite modes (the raster is the ground), so
// their values here only matter as the flash-of-color before tiles arrive —
// keep them at the background color. The background itself is the visible
// fallback when imagery fails or the camera leaves the NA bbox.
const SATELLITE_DAY: BasemapPalette = {
	background: "#0b1b33",
	land: "#0b1b33",
	lakes: "#0b1b33",
	countries: "rgba(255,255,255,0.55)",
	states: "rgba(255,255,255,0.30)",
};
const SATELLITE_NIGHT: BasemapPalette = {
	background: "#020409",
	land: "#020409",
	lakes: "#020409",
	countries: "rgba(255,255,255,0.40)",
	states: "rgba(255,255,255,0.22)",
};

export function basemapPalette(mapStyle: BasemapStyleId, darkMap: boolean): BasemapPalette {
	const tone = effectiveTone(mapStyle, darkMap);
	if (mapStyle === "radar") return RADAR;
	if (mapStyle === "satellite") return tone === "dark" ? SATELLITE_NIGHT : SATELLITE_DAY;
	return tone === "dark" ? CLASSIC_DARK : CLASSIC_LIGHT;
}

// Style-level sky (issue #221): visible when the camera pitches or the globe
// projection is active. The approved daytime pair applies on light-toned
// styles; dark-toned styles (radar scope, dark map, night satellite) get
// matching dark variants so the horizon doesn't glow daylight-blue over them.
export interface SkySpec {
	"sky-color": string;
	"horizon-color": string;
	"sky-horizon-blend": number;
	"horizon-fog-blend": number;
	// Globe-mode atmosphere halo, fading out as you zoom in (the halo is a
	// planet-scale effect; at street scale it would wash the horizon out).
	"atmosphere-blend": ExpressionSpecification;
}

const ATMOSPHERE_BLEND: ExpressionSpecification = [
	"interpolate", ["exponential", 2], ["zoom"], 0, 1, 3, .5, 8, 0,
];

const SKY_LIGHT: SkySpec = {
	"sky-color": "#94E3FE",
	"horizon-color": "#00C7FC",
	"sky-horizon-blend": 1,
	"horizon-fog-blend": 1,
	"atmosphere-blend": ATMOSPHERE_BLEND,
};
const SKY_DARK: SkySpec = { ...SKY_LIGHT, "sky-color": "#0a0a14", "horizon-color": "#1a1a2e" };
const SKY_RADAR: SkySpec = { ...SKY_LIGHT, "sky-color": "#010b04", "horizon-color": "#0f3d1f" };
const SKY_SAT_NIGHT: SkySpec = { ...SKY_LIGHT, "sky-color": "#01030a", "horizon-color": "#0a1a33" };

export function skyFor(mapStyle: BasemapStyleId, darkMap: boolean): SkySpec {
	if (mapStyle === "radar") return SKY_RADAR;
	if (effectiveTone(mapStyle, darkMap) === "light") return SKY_LIGHT;
	return mapStyle === "satellite" ? SKY_SAT_NIGHT : SKY_DARK;
}

export interface GroundVisibility {
	vector: boolean;
	satelliteDay: boolean;
	satelliteNight: boolean;
}

/** Exactly one ground renders: vector land/lakes XOR day raster XOR night raster. */
export function groundVisibility(mapStyle: BasemapStyleId, darkMap: boolean): GroundVisibility {
	if (mapStyle === "satellite") {
		const night = effectiveTone(mapStyle, darkMap) === "dark";
		return { vector: false, satelliteDay: !night, satelliteNight: night };
	}
	return { vector: true, satelliteDay: false, satelliteNight: false };
}

const NA_BBOX: [number, number, number, number] = [-150, 18, -65, 65];

const vis = (visible: boolean) => ({ visibility: visible ? "visible" : "none" }) as const;

// The superset style: every source and layer is always present; the active
// style is expressed purely through paint colors + layout visibility, so a
// live style switch is applyBasemapStyle() — never map.setStyle(), which
// would tear down the app overlay layers (flights, trails, weather radar).
// MapLibre fetches no tiles for visibility:"none" layers, so satellite
// imagery downloads only when a user actually picks it. The `background`
// layer is independent of every source: if tiles fail to load the map still
// renders (this is the existing non-fatal-basemap contract).
export function buildBasemapStyle(
	urls: BasemapUrls,
	mapStyle: BasemapStyleId,
	darkMap: boolean,
): StyleSpecification {
	const p = basemapPalette(mapStyle, darkMap);
	const g = groundVisibility(mapStyle, darkMap);
	return {
		version: 8,
		sky: skyFor(mapStyle, darkMap),
		// Glyph PBFs for symbol text (cluster counts). Missing font files are
		// non-fatal: labels just don't draw, everything else renders.
		glyphs: "https://files.911realtime.org/maps/fonts/{fontstack}/{range}.pbf",
		sources: {
			basemap: { type: "vector", url: `pmtiles://${urls.vector}` },
			"satellite-day": {
				type: "raster",
				url: `pmtiles://${urls.satelliteDay}`,
				tileSize: 256,
				bounds: NA_BBOX,
				attribution: "NASA Visible Earth",
			},
			"satellite-night": {
				type: "raster",
				url: `pmtiles://${urls.satelliteNight}`,
				tileSize: 256,
				bounds: NA_BBOX,
				attribution: "NASA Visible Earth",
			},
		},
		layers: [
			{ id: "background", type: "background", paint: { "background-color": p.background } },
			{ id: "satellite-day", type: "raster", source: "satellite-day",
				layout: vis(g.satelliteDay) },
			{ id: "satellite-night", type: "raster", source: "satellite-night",
				layout: vis(g.satelliteNight) },
			{ id: "land", type: "fill", source: "basemap", "source-layer": "land",
				layout: vis(g.vector), paint: { "fill-color": p.land } },
			{ id: "lakes", type: "fill", source: "basemap", "source-layer": "lakes",
				layout: vis(g.vector), paint: { "fill-color": p.lakes } },
			{ id: "countries", type: "line", source: "basemap", "source-layer": "countries",
				paint: { "line-color": p.countries, "line-width": 0.8 } },
			{ id: "states", type: "line", source: "basemap", "source-layer": "states",
				paint: { "line-color": p.states, "line-width": 0.4 } },
		],
	};
}

// Structural subset of maplibregl.Map so tests can pass a recording stub.
export interface StylableMap {
	setPaintProperty(layerId: string, name: string, value: unknown): unknown;
	setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
	setSky(sky: SkySpec): unknown;
}

/** Live style switch: paint + visibility only. Mirrors buildBasemapStyle exactly. */
export function applyBasemapStyle(
	map: StylableMap,
	mapStyle: BasemapStyleId,
	darkMap: boolean,
): void {
	const p = basemapPalette(mapStyle, darkMap);
	const g = groundVisibility(mapStyle, darkMap);
	map.setPaintProperty("background", "background-color", p.background);
	map.setPaintProperty("land", "fill-color", p.land);
	map.setPaintProperty("lakes", "fill-color", p.lakes);
	map.setPaintProperty("countries", "line-color", p.countries);
	map.setPaintProperty("states", "line-color", p.states);
	map.setLayoutProperty("land", "visibility", g.vector ? "visible" : "none");
	map.setLayoutProperty("lakes", "visibility", g.vector ? "visible" : "none");
	map.setLayoutProperty("satellite-day", "visibility", g.satelliteDay ? "visible" : "none");
	map.setLayoutProperty("satellite-night", "visibility", g.satelliteNight ? "visible" : "none");
	map.setSky(skyFor(mapStyle, darkMap));
}
