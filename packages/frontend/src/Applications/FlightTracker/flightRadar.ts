import type { Feature, FeatureCollection, LineString, Polygon } from "geojson";

// Radar sweep simulation: one rotation per virtual minute around the center of
// the contiguous US. The angle is DERIVED from the virtual clock (no
// accumulated state), so pausing Time Machine freezes the sweep and a seek
// just jumps its phase.
export const RADAR_CENTER: [number, number] = [-98.35, 39.83]; // Lebanon, KS
export const RADAR_PERIOD_MS = 60_000;
// Radius in normalized-mercator units (≈27° of longitude): reaches both coasts.
export const RADAR_RADIUS_MERC = 0.075;
export const RADAR_TRAIL_DEG = 45; // afterglow wedge span behind the line
export const RADAR_TRAIL_SLICES = 12;
export const RADAR_TRAIL_MAX_OPACITY = 0.35;
// Used when --color-system-04 can't be resolved (no themed ancestor; jsdom).
export const RADAR_FALLBACK_COLOR = "#808080";

const DEG2RAD = Math.PI / 180;

// Normalized Web Mercator (x,y ∈ [0,1], y grows southward). Computing the tip
// in mercator space makes the sweep trace a true circle ON SCREEN; a circle in
// raw lat/lon degrees would render as an ellipse at this latitude.
const mercX = (lon: number): number => (lon + 180) / 360;
const mercY = (lat: number): number =>
	(1 - Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2)) / Math.PI) / 2;
const lonFromMercX = (x: number): number => 360 * x - 180;
const latFromMercY = (y: number): number =>
	(2 * Math.atan(Math.exp(Math.PI * (1 - 2 * y))) - Math.PI / 2) / DEG2RAD;

const CX = mercX(RADAR_CENTER[0]);
const CY = mercY(RADAR_CENTER[1]);

/** Sweep angle in degrees, clockwise from north, [0, 360). */
export const sweepAngleDeg = (nowMs: number): number =>
	((((nowMs % RADAR_PERIOD_MS) + RADAR_PERIOD_MS) % RADAR_PERIOD_MS) / RADAR_PERIOD_MS) * 360;

const tipAt = (angleDeg: number): [number, number] => {
	const a = angleDeg * DEG2RAD;
	return [
		lonFromMercX(CX + RADAR_RADIUS_MERC * Math.sin(a)),
		latFromMercY(CY - RADAR_RADIUS_MERC * Math.cos(a)),
	];
};

/** The rotating sweep line: center → tip at the clock's current angle. */
export const sweepLineGeoJSON = (nowMs: number): Feature<LineString> => ({
	type: "Feature",
	geometry: { type: "LineString", coordinates: [RADAR_CENTER, tipAt(sweepAngleDeg(nowMs))] },
	properties: {},
});

/**
 * The afterglow: a wedge of triangle slices covering RADAR_TRAIL_DEG behind
 * the sweep line. Slice 0 abuts the line at full RADAR_TRAIL_MAX_OPACITY and
 * each older slice steps down toward 0 — the paint layer reads
 * `properties.opacity` per feature.
 */
export const sweepTrailGeoJSON = (nowMs: number): FeatureCollection<Polygon> => {
	const theta = sweepAngleDeg(nowMs);
	const step = RADAR_TRAIL_DEG / RADAR_TRAIL_SLICES;
	const features: Feature<Polygon>[] = [];
	for (let i = 0; i < RADAR_TRAIL_SLICES; i++) {
		const leading = tipAt(theta - i * step);
		const trailing = tipAt(theta - (i + 1) * step);
		features.push({
			type: "Feature",
			geometry: {
				type: "Polygon",
				coordinates: [[RADAR_CENTER, trailing, leading, RADAR_CENTER]],
			},
			properties: { opacity: RADAR_TRAIL_MAX_OPACITY * (1 - i / RADAR_TRAIL_SLICES) },
		});
	}
	return { type: "FeatureCollection", features };
};

/**
 * Resolve a CSS custom property to a concrete color string. MapLibre paints
 * into WebGL and cannot read CSS vars, so the Classicy theme color must be
 * resolved from the DOM at runtime.
 */
export const resolveCssColor = (el: Element, varName: string, fallback: string): string => {
	const v = window.getComputedStyle(el).getPropertyValue(varName).trim();
	return v || fallback;
};
