import type { FlightMotion, MotionBuffer } from "./flightMotion";
import { MAX_EXTRAPOLATION_MS, extrapolate } from "./flightMotion";
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
// Wide enough that the wall's top face dominates over the sub-quads' abutting
// side faces — hairline walls moiré into dots when subdivided finely.
export const CURTAIN_OFFSET_DEG = 0.004;

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
	return Math.min(Math.max(2 + (zoom - 3.5) * 4.5, 2), 44);
}

/** Ground km covered by one CSS pixel at a web-mercator zoom and latitude. */
export function kmPerPixel(zoom: number, lat: number): number {
	const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
	return (40_075 * cosLat) / (256 * 2 ** zoom);
}

// Aircraft silhouette on a unit grid, derived vertex-for-vertex from
// plane.svg (the 2D icon) so both modes draw the same aircraft. The SVG
// points east in a 640×640 viewBox; here each path vertex (x, y) maps to
// [lateral, forward] = [(y−320)/320, (x−320)/320], which turns the nose to
// (0, 0.9) pointing north. The icon's semicircular nose is approximated with
// three arc points. KEEP IN SYNC with plane.svg if the icon ever changes.
const PLANE_SHAPE: [number, number][] = [
	[-0.175, 0.725], [-0.124, 0.849], [0, 0.9], [0.124, 0.849], [0.175, 0.725], // nose cone
	[0.175, 0.327], [0.75, -0.2], [0.75, -0.45], [0.175, -0.258], // right wing
	[0.175, -0.57], [0.4, -0.75], [0.4, -0.9], [0, -0.8], // right tail
	[-0.4, -0.9], [-0.4, -0.75], [-0.175, -0.57], // left tail
	[-0.175, -0.258], [-0.75, -0.45], [-0.75, -0.2], [-0.175, 0.327], // left wing
	[-0.175, 0.725],
];

// Rotate/scale/translate a unit-grid ring onto the map at lon/lat.
function transformRing(
	ring: [number, number][],
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
	return ring.map(([x, y]) => {
		// Clockwise rotation by heading: north-facing shape turns toward it.
		const rx = x * cos + y * sin;
		const ry = -x * sin + y * cos;
		return [
			lon + (rx * half) / (KM_PER_DEG_LON_EQUATOR * cosLat),
			lat + (ry * half) / KM_PER_DEG_LAT,
		];
	});
}

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
	return transformRing(PLANE_SHAPE, lon, lat, headingDeg, sizeKm);
}

/**
 * Dead-reckoned altitude at `now`, mirroring how extrapolate() glides the
 * position: vertical rate from the last two samples, clamped to the same
 * MAX_EXTRAPOLATION_MS hold. Without this a descending plane rides level for
 * a minute then snaps down a step — blocky against the spline-smooth curtain.
 */
export function altitudeFtAt(m: FlightMotion, now: number): number {
	const cur = m.item.alt_ft;
	if (m.trail.length < 2 || m.curT <= m.prevT) return cur;
	const prevAlt = m.trail[m.trail.length - 2][2];
	const rate = (cur - prevAlt) / (m.curT - m.prevT); // ft per ms
	const dt = Math.min(Math.max(now - m.curT, 0), MAX_EXTRAPOLATION_MS);
	return cur + rate * dt;
}

/**
 * Lat-compensated octagon ring around lon/lat — the footprint for 3D ghost
 * "spheres" (an extruded disc; true spheres need a custom WebGL layer, and at
 * dot scale the puck reads the same).
 */
export function discRing(
	lon: number,
	lat: number,
	radiusKm: number,
	segments = 8,
): [number, number][] {
	const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
	const ring: [number, number][] = [];
	for (let i = 0; i <= segments; i++) {
		const a = (i / segments) * 2 * Math.PI;
		ring.push([
			lon + (Math.cos(a) * radiusKm) / (KM_PER_DEG_LON_EQUATOR * cosLat),
			lat + (Math.sin(a) * radiusKm) / KM_PER_DEG_LAT,
		]);
	}
	return ring;
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
		// Glided altitude: a plane extrapolated below ground (about to land)
		// simply drops out, like a flight leaving the airborne set.
		const altFt = altitudeFtAt(m, now);
		if (altFt <= 0) continue;
		const head = extrapolate(m, now);
		const centerAltM = exaggeratedHeightM(altFt);
		// One whole silhouette slab per plane, LEVEL on purpose. Fill-extrusion
		// tops are always horizontal, so representing pitch by offsetting
		// forward strips renders climbing planes as sliced staircases at close
		// zoom no matter how fine the strips (issue #250) — a genuinely angled
		// model needs a custom WebGL layer. Vertical motion still reads through
		// the glided altitude, the trail ribbon and the track curtain.
		features.push({
			type: "Feature",
			geometry: {
				type: "Polygon",
				coordinates: [planeRing(head.lon, head.lat, m.headingDeg, sizeKm)],
			},
			properties: {
				flight: m.item.flight,
				notable: isNotable(m.item.flight),
				base: centerAltM,
				height: centerAltM + thicknessM,
			},
		});
	}
	return { type: "FeatureCollection", features };
}

// 3D trails rebuild every frame for every flight, so they stay capped at the
// base TRAIL_POINTS regardless of the user's 2D length multiplier — ribbons
// for a 10× trail on thousands of flights would be a per-frame geometry
// explosion.
export const TRAIL_3D_MAX_POINTS = 20;

/**
 * Floating trail ribbons (issue #224 follow-up): each flight's breadcrumb
 * renders as thin extruded slabs at the per-point altitude instead of a
 * ground-level line — MapLibre has no elevated line layers. One quad per
 * consecutive pair; widthKm/thickness derive from the zoom-scaled plane size
 * so ribbons stay proportional to the markers.
 */
export function motionTrails3DToGeoJSON(
	buffer: MotionBuffer,
	now: number,
	displayPoints: number,
	widthKm: number,
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];
	const points = Math.min(displayPoints, TRAIL_3D_MAX_POINTS);
	if (points <= 1) return { type: "FeatureCollection", features };
	const thicknessM = widthKm * 500; // thin slab: half the ribbon width
	for (const m of buffer.values()) {
		if (m.trail.length < 2) continue;
		const head = extrapolate(m, now);
		const pts: [number, number, number][] = [
			...m.trail.slice(-points),
			[head.lon, head.lat, m.item.alt_ft],
		];
		for (let i = 1; i < pts.length; i++) {
			const [alon, alat, aalt] = pts[i - 1];
			const [blon, blat, balt] = pts[i];
			if (Math.max(aalt, balt) <= 0) continue;
			const dx = blon - alon;
			const dy = blat - alat;
			const len = Math.hypot(dx, dy);
			if (len === 0) continue;
			const cosLat = Math.max(Math.cos((alat * Math.PI) / 180), 0.01);
			const halfDeg = widthKm / 2 / (KM_PER_DEG_LAT * 1); // lat-units half width
			const ox = (-dy / len) * (halfDeg / cosLat);
			const oy = (dx / len) * halfDeg;
			// Each quad spans vertically from the LOWER endpoint's altitude to
			// the HIGHER one (± half thickness): consecutive quads meet exactly
			// at the shared point's altitude, so a climb reads as one connected
			// ramp instead of dissected blocks hovering at segment midpoints.
			const loM = exaggeratedHeightM(Math.min(aalt, balt));
			const hiM = exaggeratedHeightM(Math.max(aalt, balt));
			features.push({
				type: "Feature",
				geometry: {
					type: "Polygon",
					coordinates: [[
						[alon - ox, alat - oy],
						[blon - ox, blat - oy],
						[blon + ox, blat + oy],
						[alon + ox, alat + oy],
						[alon - ox, alat - oy],
					]],
				},
				properties: {
					notable: isNotable(m.item.flight),
					base: Math.max(loM - thicknessM / 2, 0),
					height: hiM + thicknessM / 2,
				},
			});
		}
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
// descents. Each pair is therefore subdivided into sub-quads whose tops
// follow a Catmull-Rom spline through the altitude profile (continuous slope
// across sample joints — no sharp corners), stepped finely enough that no
// adjacent step differs by more than ~165 real feet.
const CURTAIN_MAX_STEP_M = 1_000;
const CURTAIN_MAX_SUBDIVISIONS = 16;

// Catmull-Rom interpolation of altitude at t∈[0,1] between p1 and p2, with
// p0/p3 as the neighboring samples shaping the tangents. Monotone between
// same-direction neighbors, and level cruise stays perfectly level.
function splineAlt(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const m1 = (p2 - p0) / 2;
	const m2 = (p3 - p1) / 2;
	const t2 = t * t;
	const t3 = t2 * t;
	return (
		(2 * t3 - 3 * t2 + 1) * p1 +
		(t3 - 2 * t2 + t) * m1 +
		(-2 * t3 + 3 * t2) * p2 +
		(t3 - t2) * m2
	);
}

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
		// Neighboring samples shape the spline tangents (clamped at the ends).
		const prevAlt = profile[i - 2]?.alt_ft ?? a.alt_ft;
		const nextAlt = profile[i + 1]?.alt_ft ?? b.alt_ft;
		for (let s = 0; s < steps; s++) {
			const t0 = s / steps;
			const t1 = (s + 1) / steps;
			const lon0 = a.lon + dx * t0;
			const lat0 = a.lat + dy * t0;
			const lon1 = a.lon + dx * t1;
			const lat1 = a.lat + dy * t1;
			// Sub-quad top = spline altitude at the sub-segment midpoint.
			const altFt = splineAlt(prevAlt, a.alt_ft, b.alt_ft, nextAlt, (t0 + t1) / 2);
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
