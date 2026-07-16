import type { FlightMotion } from "./flightMotion";
import { MAX_EXTRAPOLATION_MS } from "./flightMotion";

// Shared 3D-altitude math. All pitched 3D geometry (aircraft models, trail
// ribbons, replay-trail spheres, the selected flight's track tube) renders
// through custom WebGL layers — see planes3DLayer.ts / trackTubeLayer.ts and
// the pure geometry builders in plane3dMesh.ts / trackTube.ts. This module
// keeps the scale/altitude primitives they share.

// Real-scale altitude is invisible at regional zooms (cruise ≈ 10 km against a
// ~1000 km viewport), so heights are exaggerated by a fixed factor.
export const ALT_EXAGGERATION = 10;
export const FT_TO_M = 0.3048;

/** Exaggerated metric height for an altitude in feet. */
export function exaggeratedHeightM(altFt: number): number {
	return altFt * FT_TO_M * ALT_EXAGGERATION;
}

// 3D geometry is geographic (km), but plane markers should track the screen
// like the 2D icons do. The rAF loop rebuilds geometry each frame, so it
// sizes markers from the live zoom: the on-screen pixel target itself GROWS
// as you zoom in (a constant-px marker reads as shrinking while the map
// features around it grow), clamped at both ends.
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
export const PLANE_SHAPE: [number, number][] = [
	[-0.175, 0.725], [-0.124, 0.849], [0, 0.9], [0.124, 0.849], [0.175, 0.725], // nose cone
	[0.175, 0.327], [0.75, -0.2], [0.75, -0.45], [0.175, -0.258], // right wing
	[0.175, -0.57], [0.4, -0.75], [0.4, -0.9], [0, -0.8], // right tail
	[-0.4, -0.9], [-0.4, -0.75], [-0.175, -0.57], // left tail
	[-0.175, -0.258], [-0.75, -0.45], [-0.75, -0.2], [-0.175, 0.327], // left wing
	[-0.175, 0.725],
];

/**
 * Dead-reckoned altitude at `now`, mirroring how extrapolate() glides the
 * position: vertical rate from the last two samples, clamped to the same
 * MAX_EXTRAPOLATION_MS hold. Without this a descending plane rides level for
 * a minute then snaps down a step — blocky against the spline-smooth track.
 */
export function altitudeFtAt(m: FlightMotion, now: number): number {
	const cur = m.item.alt_ft;
	if (m.trail.length < 2 || m.curT <= m.prevT) return cur;
	const prevAlt = m.trail[m.trail.length - 2][2];
	const rate = (cur - prevAlt) / (m.curT - m.prevT); // ft per ms
	const dt = Math.min(Math.max(now - m.curT, 0), MAX_EXTRAPOLATION_MS);
	return cur + rate * dt;
}

// 3D trails rebuild every frame for every flight, so they stay capped at the
// base TRAIL_POINTS regardless of the user's 2D length multiplier — ribbons
// for a 10× trail on thousands of flights would be a per-frame geometry
// explosion.
export const TRAIL_3D_MAX_POINTS = 20;

export interface AltitudeSample {
	lat: number;
	lon: number;
	alt_ft: number;
	utc: string;
}
