import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";

export type BasemapTheme = "light" | "dark";

interface BasemapPalette {
	background: string;
	land: string;
	lakes: string;
	countries: string;
	states: string;
}

// Two palettes for the same five layers. "light" is the original
// period-appropriate paper look; "dark" keeps the same muted, no-labels
// character on a slate-dark ground. applyMapColors and buildBasemapStyle
// share this record so the initial style and live theme switches can't drift.
export const BASEMAP_PALETTES: Record<BasemapTheme, BasemapPalette> = {
	light: {
		background: "#efe9dd",
		land: "#e3ddcf",
		lakes: "#d7d3c6",
		countries: "#8a8574",
		states: "#b3ad9c",
	},
	dark: {
		background: "#1c1c22",
		land: "#26262e",
		lakes: "#16161c",
		countries: "#6f6f7e",
		states: "#44444f",
	},
};

// Non-basemap colors that follow the theme (trails) or deliberately don't
// (the selected-track line reads fine on both palettes).
export const TRAIL_COLORS: Record<BasemapTheme, string> = {
	light: "#5a5a5a",
	dark: "#9a9aa6",
};
export const TRACK_LINE_COLOR = "#b22222";

function hexToRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A line-gradient that fades the theme's trail color from transparent at the
// oldest end of the breadcrumb (line-progress 0) to opaque at the gliding head
// (line-progress 1), so aging trail points drop out and the map self-cleans.
// Requires the flight-trails source to be created with `lineMetrics: true`.
export function trailGradient(theme: BasemapTheme): ExpressionSpecification {
	const [r, g, b] = hexToRgb(TRAIL_COLORS[theme]);
	return [
		"interpolate",
		["linear"],
		["line-progress"],
		0,
		`rgba(${r},${g},${b},0)`,
		1,
		`rgba(${r},${g},${b},0.7)`,
	] as ExpressionSpecification;
}

// A monochrome basemap style for the Mac OS 8 desktop: paper (or slate)
// background, subtle land fill, thin country borders and thinner state
// borders, muted lakes. No labels. The vector source is a self-hosted PMTiles
// archive read via the pmtiles:// protocol (registered in FlightMap). The
// `background` layer is independent of the tiles, so if the PMTiles fails to
// load the map still renders (planes draw on the ground color).
//
// Source-layer names (land/countries/states/lakes) are the contract with the
// basemap build script (scripts/build-basemap.md).
export function buildBasemapStyle(
	basemapUrl: string,
	theme: BasemapTheme = "light",
): StyleSpecification {
	const p = BASEMAP_PALETTES[theme];
	return {
		version: 8,
		sources: {
			basemap: { type: "vector", url: `pmtiles://${basemapUrl}` },
		},
		layers: [
			{ id: "background", type: "background", paint: { "background-color": p.background } },
			{ id: "land", type: "fill", source: "basemap", "source-layer": "land",
				paint: { "fill-color": p.land } },
			{ id: "lakes", type: "fill", source: "basemap", "source-layer": "lakes",
				paint: { "fill-color": p.lakes } },
			{ id: "countries", type: "line", source: "basemap", "source-layer": "countries",
				paint: { "line-color": p.countries, "line-width": 0.8 } },
			{ id: "states", type: "line", source: "basemap", "source-layer": "states",
				paint: { "line-color": p.states, "line-width": 0.4 } },
		],
	};
}

/** The theme/pin colors FlightMap needs, as CSS hex strings. */
export interface FlightMapColors {
	darkMap: boolean;
	pinColor: string;
	notablePinColor: string;
}

// Structural subset of maplibregl.Map so tests can pass a recording stub.
export interface PaintableMap {
	setPaintProperty(layerId: string, name: string, value: unknown): unknown;
}

// Live re-theme: setPaintProperty on every color-bearing layer. Callers use
// this instead of map.setStyle(), which would tear down the flights/trails/
// track sources and layers.
export function applyMapColors(map: PaintableMap, colors: FlightMapColors): void {
	const theme: BasemapTheme = colors.darkMap ? "dark" : "light";
	const p = BASEMAP_PALETTES[theme];
	map.setPaintProperty("background", "background-color", p.background);
	map.setPaintProperty("land", "fill-color", p.land);
	map.setPaintProperty("lakes", "fill-color", p.lakes);
	map.setPaintProperty("countries", "line-color", p.countries);
	map.setPaintProperty("states", "line-color", p.states);
	map.setPaintProperty("flight-trails", "line-gradient", trailGradient(theme));
	// Pin colors are NOT set here: the plane layers are symbol layers whose
	// icons bake the color in (see flightIcons + FlightMap's installPlaneIcons).
}
