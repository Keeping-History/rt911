import type { AltitudeSample } from "./flightAltitude";
import { altitudeFtAt, exaggeratedHeightM } from "./flightAltitude";
import type { LandingClock, MotionBuffer } from "./flightMotion";
import { extrapolate, motionNow } from "./flightMotion";
import { TRAIL_3D_MAX_POINTS } from "./flightAltitude";
import { phaseColorRgb01 } from "./flightPhases";
import { lngLatToMercator, mercatorPerMeter } from "./plane3dMesh";

// Smooth 3D flight track. The fill-extrusion curtain can only staircase —
// extrusion tops are flat per feature and its footprint is straight lines
// between minute samples. This module splines the altitude profile in all
// three axes (Catmull-Rom, continuous slope across sample joints — the way a
// real flight path bends) and wraps it in a thin tube whose cross-section
// radius is applied in the SHADER (trackTubeLayer.ts), so zoom-tracking
// thickness is a uniform update, not a geometry rebuild. Pure math — no
// WebGL, no maplibre — unit-testable in jsdom.

export const TUBE_SIDES = 6;
const DEFAULT_STEPS = 4;

export interface TrackPoint {
	lon: number;
	lat: number;
	alt_ft: number;
	phase?: string;
}

// Catmull-Rom interpolation at t∈[0,1] between p1 and p2, with p0/p3 shaping
// the tangents (same scheme as the curtain's altitude spline). Collinear
// evenly-spaced samples interpolate linearly — straight legs stay straight.
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
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
 * Catmull-Rom-splined track through the points: `steps` interpolated points
 * per pair, passing exactly through every original point. Inputs too short to
 * spline come back as-is. (AltitudeSample is structurally a TrackPoint, so
 * altitude profiles feed straight in.)
 */
export function splineTrack(profile: TrackPoint[], steps: number): TrackPoint[] {
	if (profile.length < 2) {
		return profile.map(({ lon, lat, alt_ft }) => ({ lon, lat, alt_ft }));
	}
	const pts: TrackPoint[] = [];
	for (let i = 1; i < profile.length; i++) {
		const p0 = profile[i - 2] ?? profile[i - 1];
		const p1 = profile[i - 1];
		const p2 = profile[i];
		const p3 = profile[i + 1] ?? profile[i];
		for (let s = 0; s < steps; s++) {
			const t = s / steps;
			pts.push({
				lon: catmullRom(p0.lon, p1.lon, p2.lon, p3.lon, t),
				lat: catmullRom(p0.lat, p1.lat, p2.lat, p3.lat, t),
				alt_ft: catmullRom(p0.alt_ft, p1.alt_ft, p2.alt_ft, p3.alt_ft, t),
				phase: p1.phase, // hard color break at each real sample (snap-to-point)
			});
		}
	}
	const last = profile[profile.length - 1];
	pts.push({ lon: last.lon, lat: last.lat, alt_ft: last.alt_ft, phase: last.phase });
	return pts;
}

export interface TrackTube {
	/** vec4 per vertex: mercX, mercY, exaggerated elevation (m), mercator units per meter. */
	centers: Float32Array;
	/**
	 * vec4 per vertex: ENU unit offset from the centerline (xyz — also the
	 * shading normal) + an opacity multiplier (w; the trail fade).
	 */
	offsets: Float32Array;
	/** vec3 per vertex: RGB (0..1). Present for the phase-colored track tube;
	 * undefined for trail ribbons (which use the layer's uniform color). */
	colors?: Float32Array;
	vertexCount: number;
}

const EMPTY_TUBE: TrackTube = {
	centers: new Float32Array(0),
	offsets: new Float32Array(0),
	vertexCount: 0,
};

/**
 * Tube mesh around the splined track. Each ring carries its centerline point
 * (duplicated per vertex) plus a unit offset direction perpendicular to the
 * local tangent; the shader displaces by offset × radius, so the geometry is
 * radius-independent. Winding is irrelevant — the layer draws with face
 * culling off, like the plane prisms.
 */
export function buildTrackTube(
	profile: AltitudeSample[] | null,
	steps = DEFAULT_STEPS,
): TrackTube {
	if (!profile || profile.length < 2) return EMPTY_TUBE;
	const pts = splineTrack(profile, steps);
	const n = pts.length;
	const pointColor = pts.map((p) => phaseColorRgb01(p.phase));

	// Per-point center data and ring frames.
	const cx = new Float64Array(n); // mercator x
	const cy = new Float64Array(n); // mercator y
	const ce = new Float64Array(n); // exaggerated elevation, meters
	const cm = new Float64Array(n); // mercator units per meter
	for (let i = 0; i < n; i++) {
		const [mx, my] = lngLatToMercator(pts[i].lon, pts[i].lat);
		cx[i] = mx;
		cy[i] = my;
		ce[i] = exaggeratedHeightM(Math.max(pts[i].alt_ft, 0));
		cm[i] = mercatorPerMeter(pts[i].lat);
	}

	// Ring offset directions in local ENU meters: U horizontal-perpendicular
	// to the tangent, V completing the frame (up-ish). Flight tangents are
	// never vertical, but the guard keeps a degenerate pair from emitting NaNs.
	const dirs: number[][] = new Array(n);
	for (let i = 0; i < n; i++) {
		const a = Math.max(i - 1, 0);
		const b = Math.min(i + 1, n - 1);
		const tE = (cx[b] - cx[a]) / cm[i];
		const tN = -(cy[b] - cy[a]) / cm[i]; // mercator y grows south
		const tU = ce[b] - ce[a];
		const tLen = Math.hypot(tE, tN, tU);
		const [e, nn, u] = tLen > 0 ? [tE / tLen, tN / tLen, tU / tLen] : [1, 0, 0];
		// U = T × Z (horizontal, ⊥ T); falls back east for a vertical tangent.
		const uLen = Math.hypot(nn, e);
		const [uE, uN] = uLen > 1e-9 ? [nn / uLen, -e / uLen] : [1, 0];
		// V = U × T.
		const vE = uN * u;
		const vN = -uE * u;
		const vU = uE * nn - uN * e;
		const ring: number[] = [];
		for (let k = 0; k < TUBE_SIDES; k++) {
			const th = (k / TUBE_SIDES) * 2 * Math.PI;
			const c = Math.cos(th);
			const s = Math.sin(th);
			ring.push(c * uE + s * vE, c * uN + s * vN, s * vU);
		}
		dirs[i] = ring;
	}

	// Two triangles per side per ring pair, flat vertex streams (no index).
	const quads = (n - 1) * TUBE_SIDES;
	const vertexCount = quads * 2 * 3;
	const centers = new Float32Array(vertexCount * 4);
	const offsets = new Float32Array(vertexCount * 4);
	const colors = new Float32Array(vertexCount * 3);
	let v = 0;
	const emit = (ring: number, side: number) => {
		const c4 = v * 4;
		centers[c4] = cx[ring];
		centers[c4 + 1] = cy[ring];
		centers[c4 + 2] = ce[ring];
		centers[c4 + 3] = cm[ring];
		const o4 = v * 4;
		const d = dirs[ring];
		const k = side * 3;
		offsets[o4] = d[k];
		offsets[o4 + 1] = d[k + 1];
		offsets[o4 + 2] = d[k + 2];
		offsets[o4 + 3] = 1; // the selected track never fades
		const g3 = v * 3;
		const col = pointColor[ring];
		colors[g3] = col[0];
		colors[g3 + 1] = col[1];
		colors[g3 + 2] = col[2];
		v++;
	};
	for (let i = 0; i < n - 1; i++) {
		for (let k = 0; k < TUBE_SIDES; k++) {
			const k2 = (k + 1) % TUBE_SIDES;
			emit(i, k);
			emit(i + 1, k);
			emit(i + 1, k2);
			emit(i, k);
			emit(i + 1, k2);
			emit(i, k2);
		}
	}
	return { centers, offsets, colors, vertexCount };
}

// --- live trail ribbons --------------------------------------------------------

// Opacity along the trail as a fraction of its length measured FROM the
// plane (0 = at the aircraft, 1 = the oldest tip): solid for the newest
// half, then stepping down to fully transparent at the tip.
const TRAIL_FADE_STOPS: [number, number][] = [
	[0, 1], [0.5, 1], [0.7, 0.5], [0.8, 0.25], [0.9, 0.1], [1, 0],
];

/** Piecewise-linear trail opacity at fraction-from-plane `f`, clamped. */
export function trailFadeAt(f: number): number {
	if (f <= 0) return 1;
	if (f >= 1) return 0;
	for (let i = 1; i < TRAIL_FADE_STOPS.length; i++) {
		const [f1, a1] = TRAIL_FADE_STOPS[i];
		if (f <= f1) {
			const [f0, a0] = TRAIL_FADE_STOPS[i - 1];
			return a0 + ((f - f0) / (f1 - f0)) * (a1 - a0);
		}
	}
	return 0;
}

export interface TrailTubeOptions {
	/** Breadcrumb points per flight (already multiplier-scaled; capped below). */
	displayPoints: number;
	/** Catmull-Rom subdivisions per segment — zoom-adaptive at the call site. */
	steps: number;
	/**
	 * Meters to pull the ribbon's end back along the heading, so the trail
	 * stops at the aircraft's TAIL instead of running under its center
	 * (half the marker size at the call site).
	 */
	headOffsetM: number;
	landing?: LandingClock;
}

/**
 * Smooth 3D trail ribbons: every airborne flight's breadcrumb splined through
 * lon/lat/altitude (same Catmull-Rom as the track tube) into a flat
 * two-vertex-ring ribbon with per-vertex elevation — replacing the straight
 * fill-extrusion slabs that cornered at every minute sample. The ribbon's
 * head rides at the plane's GLIDED altitude (altitudeFtAt — the same value
 * the 3D model floats at, so the trail meets the fuselage centerline) and is
 * pulled back to the tail by headOffsetM.
 *
 * PERF: this runs per frame over thousands of flights, so it fills reusable
 * module-level scratch buffers in a single pass — zero per-flight allocation
 * (per-frame GC churn at this scale renders at seconds per frame, not
 * frames per second). The returned arrays are views into the scratch: valid
 * until the next call, which is exactly the lifetime the GL layer needs
 * (upload happens in the same frame).
 */
// Scratch pools, grown geometrically and kept for the page lifetime.
let ringScratch = new Float64Array(64 * 6); // per-ring: x, y, elev, mpm, ux, uy
let centersScratch = new Float32Array(4096 * 4);
let offsetsScratch = new Float32Array(4096 * 4);

function ensureVertexCapacity(verts: number): void {
	if (centersScratch.length < verts * 4) {
		let cap = centersScratch.length / 4;
		while (cap < verts) cap *= 2;
		centersScratch = new Float32Array(cap * 4);
		offsetsScratch = new Float32Array(cap * 4);
	}
}

export function buildTrailTubes(
	buffer: MotionBuffer,
	now: number,
	opts: TrailTubeOptions,
): TrackTube {
	const points = Math.min(opts.displayPoints, TRAIL_3D_MAX_POINTS);
	if (points <= 1) return { centers: new Float32Array(0), offsets: new Float32Array(0), vertexCount: 0 };
	const { steps, headOffsetM, landing } = opts;

	// Upper bound on vertices: rings ≤ points·steps + 1 per flight, 6 verts
	// per ring pair.
	const maxRings = points * steps + 1;
	ensureVertexCapacity(buffer.size * (maxRings - 1) * 6);
	if (ringScratch.length < maxRings * 6) ringScratch = new Float64Array(maxRings * 6);

	let v = 0;
	for (const m of buffer.values()) {
		const trailLen = Math.min(m.trail.length, points);
		if (trailLen < 2) continue;
		const effNow = motionNow(m, now, landing);
		const head = extrapolate(m, effNow);
		const headAltFt = altitudeFtAt(m, effNow);
		// Tail alignment: retreat the endpoint along the heading (equatorial
		// meters-per-degree for the east component, meridional for north —
		// same constants as the rest of the geometry math).
		const th = (m.headingDeg * Math.PI) / 180;
		const cosLat = Math.max(Math.cos((head.lat * Math.PI) / 180), 0.01);
		const tailLon = head.lon - (Math.sin(th) * headOffsetM) / (111_320 * cosLat);
		const tailLat = head.lat - (Math.cos(th) * headOffsetM) / 110_574;

		// Splined rings straight into the ring scratch: pts = breadcrumb tail
		// + glided head, Catmull-Rom sampled at `steps` per segment.
		const base = m.trail.length - trailLen;
		const segs = trailLen; // trailLen breadcrumbs + head = trailLen segments
		const pt = (i: number): [number, number, number] => {
			if (i < trailLen) {
				const p = m.trail[base + i];
				return [p[0], p[1], p[2]];
			}
			return [tailLon, tailLat, headAltFt];
		};
		let rings = 0;
		for (let i = 0; i < segs; i++) {
			const [x0, y0, a0] = pt(Math.max(i - 1, 0));
			const [x1, y1, a1] = pt(i);
			const [x2, y2, a2] = pt(i + 1);
			const [x3, y3, a3] = pt(Math.min(i + 2, segs));
			for (let sIdx = 0; sIdx < steps; sIdx++) {
				const t = sIdx / steps;
				const lon = catmullRom(x0, x1, x2, x3, t);
				const lat = catmullRom(y0, y1, y2, y3, t);
				const alt = catmullRom(a0, a1, a2, a3, t);
				const r6 = rings * 6;
				const [mx, my] = lngLatToMercator(lon, lat);
				ringScratch[r6] = mx;
				ringScratch[r6 + 1] = my;
				ringScratch[r6 + 2] = exaggeratedHeightM(Math.max(alt, 0));
				ringScratch[r6 + 3] = mercatorPerMeter(lat);
				rings++;
			}
		}
		{
			const r6 = rings * 6;
			const [mx, my] = lngLatToMercator(tailLon, tailLat);
			ringScratch[r6] = mx;
			ringScratch[r6 + 1] = my;
			ringScratch[r6 + 2] = exaggeratedHeightM(Math.max(headAltFt, 0));
			ringScratch[r6 + 3] = mercatorPerMeter(tailLat);
			rings++;
		}

		// Horizontal unit perpendicular to the local tangent per ring.
		for (let i = 0; i < rings; i++) {
			const a6 = Math.max(i - 1, 0) * 6;
			const b6 = Math.min(i + 1, rings - 1) * 6;
			const i6 = i * 6;
			const tE = (ringScratch[b6] - ringScratch[a6]) / ringScratch[i6 + 3];
			const tN = -(ringScratch[b6 + 1] - ringScratch[a6 + 1]) / ringScratch[i6 + 3];
			const len = Math.hypot(tE, tN);
			ringScratch[i6 + 4] = len > 1e-12 ? tN / len : 1;
			ringScratch[i6 + 5] = len > 1e-12 ? -tE / len : 0;
		}

		// Two triangles per ring pair, emitted inline into the packed scratch.
		// Rings run oldest -> newest, so fraction-from-plane at ring i is
		// (rings-1-i)/(rings-1); the fade goes transparent at the oldest tip.
		for (let i = 0; i < rings - 1; i++) {
			const lo = i * 6;
			const hi = (i + 1) * 6;
			const alphaLo = trailFadeAt((rings - 1 - i) / (rings - 1));
			const alphaHi = trailFadeAt((rings - 2 - i) / (rings - 1));
			// (i,-1) (i+1,-1) (i+1,+1) / (i,-1) (i+1,+1) (i,+1)
			for (const [r6, side, alpha] of [
				[lo, -1, alphaLo], [hi, -1, alphaHi], [hi, 1, alphaHi],
				[lo, -1, alphaLo], [hi, 1, alphaHi], [lo, 1, alphaLo],
			] as const) {
				const c4 = v * 4;
				centersScratch[c4] = ringScratch[r6];
				centersScratch[c4 + 1] = ringScratch[r6 + 1];
				centersScratch[c4 + 2] = ringScratch[r6 + 2];
				centersScratch[c4 + 3] = ringScratch[r6 + 3];
				const o4 = v * 4;
				offsetsScratch[o4] = side * ringScratch[r6 + 4];
				offsetsScratch[o4 + 1] = side * ringScratch[r6 + 5];
				offsetsScratch[o4 + 2] = 0;
				offsetsScratch[o4 + 3] = alpha;
				v++;
			}
		}
	}
	return {
		centers: centersScratch.subarray(0, v * 4),
		offsets: offsetsScratch.subarray(0, v * 4),
		vertexCount: v,
	};
}
