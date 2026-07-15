import type { AltitudeSample } from "./flightAltitude";
import { exaggeratedHeightM } from "./flightAltitude";
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
 * Catmull-Rom-splined track through the profile: `steps` interpolated points
 * per sample pair, passing exactly through every original sample. Profiles too
 * short to spline come back as-is.
 */
export function splineTrack(profile: AltitudeSample[], steps: number): TrackPoint[] {
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
			});
		}
	}
	const last = profile[profile.length - 1];
	pts.push({ lon: last.lon, lat: last.lat, alt_ft: last.alt_ft });
	return pts;
}

export interface TrackTube {
	/** vec4 per vertex: mercX, mercY, exaggerated elevation (m), mercator units per meter. */
	centers: Float32Array;
	/** vec3 per vertex: ENU unit offset from the centerline — also the shading normal. */
	offsets: Float32Array;
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
	const offsets = new Float32Array(vertexCount * 3);
	let v = 0;
	const emit = (ring: number, side: number) => {
		const c4 = v * 4;
		centers[c4] = cx[ring];
		centers[c4 + 1] = cy[ring];
		centers[c4 + 2] = ce[ring];
		centers[c4 + 3] = cm[ring];
		const o3 = v * 3;
		const d = dirs[ring];
		const k = side * 3;
		offsets[o3] = d[k];
		offsets[o3 + 1] = d[k + 1];
		offsets[o3 + 2] = d[k + 2];
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
	return { centers, offsets, vertexCount };
}
