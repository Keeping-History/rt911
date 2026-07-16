import type { ExpressionSpecification } from "maplibre-gl";
import {
	applyBasemapStyle,
	type BasemapStyleId,
	effectiveTone,
	type StylableMap,
} from "../../lib/basemap/basemapStyles";

// The basemap palette/style-building half of this module moved to the shared
// src/lib/basemap module (the Weather app renders the same basemap). What
// stays here is flight-specific: trail colors/gradient, the selected-track
// line, and applyMapColors, which recolors the flight overlay layers on top
// of the shared basemap switch.
export {
	BASEMAP_URLS,
	type BasemapStyleId,
	type BasemapTone,
	type BasemapUrls,
	buildBasemapStyle,
	effectiveTone,
	normalizeBasemapStyle,
} from "../../lib/basemap/basemapStyles";

// Per-style trail colors, keyed by the style's effective tone. The selected-
// track line reads fine on every ground and deliberately doesn't change.
const TRAIL_COLORS: Record<BasemapStyleId, Record<"light" | "dark", string>> = {
	classic: { light: "#5a5a5a", dark: "#9a9aa6" },
	radar: { light: "#39d353", dark: "#39d353" }, // tone is always dark; light is unreachable
	satellite: { light: "#f2f2f2", dark: "#cfd8e3" },
};
export const TRACK_LINE_COLOR = "#b22222";
// While pitched, the elevated track tube carries TRACK_LINE_COLOR and the
// ground line drops to 50% brightness (each RGB channel halved) so it reads
// as the tube's shadow. Flat views keep the full color — there the ground
// line IS the track.
export const TRACK_SHADOW_COLOR = "#591111";

export function trailColor(mapStyle: BasemapStyleId, darkMap: boolean): string {
	return TRAIL_COLORS[mapStyle][effectiveTone(mapStyle, darkMap)];
}

function hexToRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A line-gradient that fades the style's trail color from transparent at the
// oldest end of the breadcrumb (line-progress 0) to opaque at the gliding head
// (line-progress 1), so aging trail points drop out and the map self-cleans.
// Requires the flight-trails source to be created with `lineMetrics: true`.
export function trailGradient(
	mapStyle: BasemapStyleId,
	darkMap: boolean,
): ExpressionSpecification {
	const [r, g, b] = hexToRgb(trailColor(mapStyle, darkMap));
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

/** The style/pin inputs FlightMap needs; pin colors as CSS hex strings. */
export interface FlightMapColors {
	mapStyle: BasemapStyleId;
	darkMap: boolean;
	pinColor: string;
	notablePinColor: string;
	observerPinColor: string;
	// Topography toggle: hillshade visibility rides the shared basemap switch.
	terrain: boolean;
}

// The replay-trail highlight layer serves notables AND observers (GOFER06);
// circles recolor via paint, so the split is a data-driven case expression.
export function highlightTrailColor(
	notablePinColor: string,
	observerPinColor: string,
): ExpressionSpecification {
	return [
		"case",
		["==", ["get", "observer"], true],
		observerPinColor,
		notablePinColor,
	] as ExpressionSpecification;
}

// Kept as the historical local name; identical to the shared StylableMap.
export type PaintableMap = StylableMap;

// Live re-style: shared basemap switch (paint + ground visibility) plus the
// flight overlays. Callers use this instead of map.setStyle(), which would
// tear down the flights/trails/track sources and layers.
export function applyMapColors(map: PaintableMap, colors: FlightMapColors): void {
	applyBasemapStyle(map, colors.mapStyle, colors.darkMap, colors.terrain);
	map.setPaintProperty(
		"flight-trails",
		"line-gradient",
		trailGradient(colors.mapStyle, colors.darkMap),
	);
	// Live pin colors are NOT set here: the plane layers are symbol layers whose
	// icons bake the color in (see flightIcons + FlightMap's installPlaneIcons).
	// The loop-mode replay-trail layers stay plain circles, so they DO recolor here.
	map.setPaintProperty("replay-trail-dots", "circle-color", colors.pinColor);
	map.setPaintProperty(
		"replay-trail-notable",
		"circle-color",
		highlightTrailColor(colors.notablePinColor, colors.observerPinColor),
	);
	// Cluster blobs follow the pin color too (the clustered plane icons share
	// the baked-in plane-icon image, so they recolor via installPlaneIcons).
	map.setPaintProperty("cluster-circles", "circle-color", colors.pinColor);
	// The 3D geometry (aircraft models, trail ribbons, spheres, track tube)
	// lives in custom WebGL layers whose colors FlightMap re-applies directly
	// (setColors/setColor) — no paint properties to update here.
}
