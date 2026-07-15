import type { MotionBuffer } from "./flightMotion";
import { extrapolate } from "./flightMotion";
import { isNotable } from "./notableFlights";

// 3D altitude rendering (issue #224). MapLibre has no elevated symbol layers —
// icons are ground-clamped — so while the camera is pitched each aircraft
// renders natively as a plane-shaped polygon extruded into a thin slab AT its
// altitude (base = altitude, top = altitude + thickness), heading-rotated;
// the flat icons hide. The selected flight's path gets a curtain wall
// (curtainToGeoJSON).

// Real-scale altitude is invisible at regional zooms (cruise ≈ 10 km against a
// ~1000 km viewport), so heights are exaggerated by a fixed factor.
export const ALT_EXAGGERATION = 10;
export const FT_TO_M = 0.3048;
// Perpendicular thickness of a curtain-wall segment, in degrees latitude.
export const CURTAIN_OFFSET_DEG = 0.002;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

/** Exaggerated metric height for an altitude in feet. */
export function exaggeratedHeightM(altFt: number): number {
	return altFt * FT_TO_M * ALT_EXAGGERATION;
}

// Fill-extrusion geometry is geographic (km), but plane markers should track
// the screen like the 2D icons do. The rAF loop rebuilds the GeoJSON each
// frame, so it sizes the silhouette from the live zoom: the on-screen pixel
// target itself GROWS as you zoom in (a constant-px marker reads as shrinking
// while the map features around it grow), clamped at both ends.
export function plane3DTargetPx(zoom: number): number {
	return Math.min(Math.max(16 + (zoom - 3.5) * 4.5, 16), 44);
}

/** Ground km covered by one CSS pixel at a web-mercator zoom and latitude. */
export function kmPerPixel(zoom: number, lat: number): number {
	const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
	return (40_075 * cosLat) / (256 * 2 ** zoom);
}

// Stylized aircraft silhouette on a unit grid, nose at (0, 1) pointing north,
// wingspan ±0.95, tail at the bottom. One closed ring, coarse enough to stay
// cheap at a few thousand planes per frame.
const PLANE_SHAPE: [number, number][] = [
	[0, 1], [0.14, 0.55], [0.95, 0.1], [0.95, -0.08], [0.14, -0.02],
	[0.12, -0.55], [0.42, -0.78], [0.42, -0.92], [0, -0.8],
	[-0.42, -0.92], [-0.42, -0.78], [-0.12, -0.55], [-0.14, -0.02],
	[-0.95, -0.08], [-0.95, 0.1], [-0.14, 0.55], [0, 1],
];

/**
 * Plane-silhouette ring centered on lon/lat, rotated clockwise-from-north by
 * headingDeg, sized so the wingspan is ~sizeKm. Longitude compensated by
 * cos(lat) so the shape doesn't stretch at northern latitudes.
 */
export function planeRing(
	lon: number,
	lat: number,
	headingDeg: number,
	sizeKm: number,
): [number, number][] {
	const th = (headingDeg * Math.PI) / 180;
	const cos = Math.cos(th);
	const sin = Math.sin(th);
	const half = sizeKm / 2;
	const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
	return PLANE_SHAPE.map(([x, y]) => {
		// Clockwise rotation by heading: north-facing shape turns toward it.
		const rx = x * cos + y * sin;
		const ry = -x * sin + y * cos;
		return [
			lon + (rx * half) / (KM_PER_DEG_LON_EQUATOR * cosLat),
			lat + (ry * half) / KM_PER_DEG_LAT,
		];
	});
}

// Slab thickness as a fraction of the marker size — enough body to shade like
// a solid object without reading as a column.
const PLANE_3D_THICKNESS = 0.12;

/**
 * One heading-rotated plane slab per airborne flight, floating at its
 * exaggerated altitude: properties { flight, notable, base, height } feed
 * fill-extrusion-base/-height. sizeKm comes from the live zoom (kmPerPixel ×
 * plane3DTargetPx). Flights at/below ground level emit nothing.
 */
export function motionPlanes3DToGeoJSON(
	buffer: MotionBuffer,
	now: number,
	sizeKm: number,
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];
	const thicknessM = sizeKm * PLANE_3D_THICKNESS * 1000;
	for (const m of buffer.values()) {
		if (m.item.alt_ft <= 0) continue;
		const head = extrapolate(m, now);
		const base = exaggeratedHeightM(m.item.alt_ft);
		features.push({
			type: "Feature",
			geometry: {
				type: "Polygon",
				coordinates: [planeRing(head.lon, head.lat, m.headingDeg, sizeKm)],
			},
			properties: {
				flight: m.item.flight,
				notable: isNotable(m.item.flight),
				base,
				height: base + thicknessM,
			},
		});
	}
	return { type: "FeatureCollection", features };
}

export interface AltitudeSample {
	lat: number;
	lon: number;
	alt_ft: number;
	utc: string;
}

// fill-extrusion height is per-FEATURE, so a single quad can only have a flat
// top — a raw one-quad-per-minute curtain staircases hard on climbs and
// descents. Each pair is therefore subdivided into altitude-lerped sub-quads
// so no adjacent step differs by more than this many exaggerated meters
// (≈650 real feet), which reads as a smooth ramp at flight scales.
const CURTAIN_MAX_STEP_M = 2_000;
const CURTAIN_MAX_SUBDIVISIONS = 8;

/**
 * Curtain wall under a flight path: thin extruded quads following the path,
 * tops tracking the (linearly interpolated) altitude between samples. The
 * perpendicular offset gives each wall segment polygon area — a bare segment
 * would be degenerate. Returns an empty FC for null/short profiles.
 */
export function curtainToGeoJSON(
	profile: AltitudeSample[] | null,
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];
	if (!profile || profile.length < 2) return { type: "FeatureCollection", features };
	for (let i = 1; i < profile.length; i++) {
		const a = profile[i - 1];
		const b = profile[i];
		if (Math.max(a.alt_ft, b.alt_ft) <= 0) continue;
		// Perpendicular to the segment in lat/lon space, normalized to
		// CURTAIN_OFFSET_DEG; degenerate (same-point) pairs fall back to a
		// north offset so the quad still has area.
		const dx = b.lon - a.lon;
		const dy = b.lat - a.lat;
		const len = Math.hypot(dx, dy);
		const ox = len > 0 ? (-dy / len) * CURTAIN_OFFSET_DEG : 0;
		const oy = len > 0 ? (dx / len) * CURTAIN_OFFSET_DEG : CURTAIN_OFFSET_DEG;
		const dAltM = Math.abs(exaggeratedHeightM(b.alt_ft) - exaggeratedHeightM(a.alt_ft));
		const steps = Math.min(
			Math.max(Math.ceil(dAltM / CURTAIN_MAX_STEP_M), 1),
			CURTAIN_MAX_SUBDIVISIONS,
		);
		for (let s = 0; s < steps; s++) {
			const t0 = s / steps;
			const t1 = (s + 1) / steps;
			const lon0 = a.lon + dx * t0;
			const lat0 = a.lat + dy * t0;
			const lon1 = a.lon + dx * t1;
			const lat1 = a.lat + dy * t1;
			// Sub-quad top = altitude at the sub-segment midpoint.
			const altFt = a.alt_ft + (b.alt_ft - a.alt_ft) * ((t0 + t1) / 2);
			if (altFt <= 0) continue;
			features.push({
				type: "Feature",
				geometry: {
					type: "Polygon",
					coordinates: [[
						[lon0, lat0],
						[lon1, lat1],
						[lon1 + ox, lat1 + oy],
						[lon0 + ox, lat0 + oy],
						[lon0, lat0],
					]],
				},
				properties: { height: exaggeratedHeightM(altFt) },
			});
		}
	}
	return { type: "FeatureCollection", features };
}
