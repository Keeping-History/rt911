import type { FlightMotion, LandingClock, MotionBuffer } from "./flightMotion";
import { extrapolate, motionNow } from "./flightMotion";
import { PLANE_SHAPE, altitudeFtAt, exaggeratedHeightM } from "./flightAltitude";
import { isNotable, isObserver } from "./notableFlights";

// Geometry and per-frame instance data for the true-3D aircraft layer
// (issue #250). Everything here is pure math — no WebGL, no maplibre — so
// the mesh, the triangulation and the instance packing are unit-testable in
// jsdom. planes3DLayer.ts consumes these on the GPU side.

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/** Web-mercator [x, y] in 0..1 world coordinates (y grows southward). */
export function lngLatToMercator(lon: number, lat: number): [number, number] {
	const phi = (lat * Math.PI) / 180;
	return [
		(lon + 180) / 360,
		(1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2,
	];
}

/** Mercator world units per meter of ground/altitude at a latitude. */
export function mercatorPerMeter(lat: number): number {
	return 1 / (EARTH_CIRCUMFERENCE_M * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
}

// --- silhouette triangulation -----------------------------------------------

function signedArea(ring: [number, number][]): number {
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x1, y1] = ring[i];
		const [x2, y2] = ring[(i + 1) % ring.length];
		area += x1 * y2 - x2 * y1;
	}
	return area / 2;
}

const EPS = 1e-9;

/**
 * Ear-clipping triangulation of a simple (possibly concave) polygon. Input is
 * an OPEN ring (no duplicated last vertex); output is index triples into it.
 * O(n³) worst case — fine, it runs once at module load on a ~20-vertex shape.
 */
export function triangulate(ring: [number, number][]): number[] {
	const idx = [...Array(ring.length).keys()];
	if (signedArea(ring) < 0) idx.reverse(); // ear test below assumes CCW
	const cross = (a: [number, number], b: [number, number], c: [number, number]) =>
		(b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	const tris: number[] = [];
	let guard = ring.length * ring.length * ring.length;
	while (idx.length > 3 && guard-- > 0) {
		let clipped = false;
		for (let i = 0; i < idx.length; i++) {
			const ia = idx[(i + idx.length - 1) % idx.length];
			const ib = idx[i];
			const ic = idx[(i + 1) % idx.length];
			const a = ring[ia];
			const b = ring[ib];
			const c = ring[ic];
			if (cross(a, b, c) <= EPS) continue; // reflex/degenerate corner
			let contains = false;
			for (const j of idx) {
				if (j === ia || j === ib || j === ic) continue;
				const p = ring[j];
				if (
					cross(a, b, p) >= -EPS &&
					cross(b, c, p) >= -EPS &&
					cross(c, a, p) >= -EPS
				) {
					contains = true;
					break;
				}
			}
			if (contains) continue;
			tris.push(ia, ib, ic);
			idx.splice(i, 1);
			clipped = true;
			break;
		}
		if (!clipped) break; // numerically stuck — emit what we have
	}
	if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
	return tris;
}

// --- prism mesh --------------------------------------------------------------

// Local mesh frame: x lateral (east at heading 0), y forward (north at
// heading 0), z up. Same ±0.12 z half-thickness as the old extrusion slab.
export const PLANE_MESH_HALF_THICKNESS = 0.12;

export interface PlaneMesh {
	positions: Float32Array; // xyz per vertex, flat-shaded (verts duplicated per face)
	normals: Float32Array;
	vertexCount: number;
}

/** Extrude the icon-derived silhouette into a flat-shaded prism. */
export function buildPlaneMesh(): PlaneMesh {
	const ring = PLANE_SHAPE.slice(0, -1) as [number, number][]; // drop closing dup
	const ccw = signedArea(ring) >= 0 ? ring : [...ring].reverse();
	const tris = triangulate(ccw);
	const T = PLANE_MESH_HALF_THICKNESS;
	const pos: number[] = [];
	const nrm: number[] = [];
	const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
		pos.push(x, y, z);
		nrm.push(nx, ny, nz);
	};
	// Top and bottom faces from the triangulation (bottom winding reversed).
	for (let i = 0; i < tris.length; i += 3) {
		const [a, b, c] = [ccw[tris[i]], ccw[tris[i + 1]], ccw[tris[i + 2]]];
		push(a[0], a[1], T, 0, 0, 1);
		push(b[0], b[1], T, 0, 0, 1);
		push(c[0], c[1], T, 0, 0, 1);
		push(c[0], c[1], -T, 0, 0, -1);
		push(b[0], b[1], -T, 0, 0, -1);
		push(a[0], a[1], -T, 0, 0, -1);
	}
	// Side walls: one quad (two tris) per ring edge, outward flat normal.
	// For a CCW ring the interior lies left of each edge → outward is right:
	// (dy, -dx) normalized.
	for (let i = 0; i < ccw.length; i++) {
		const a = ccw[i];
		const b = ccw[(i + 1) % ccw.length];
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const len = Math.hypot(dx, dy);
		if (len < EPS) continue;
		const nx = dy / len;
		const ny = -dx / len;
		push(a[0], a[1], -T, nx, ny, 0);
		push(b[0], b[1], -T, nx, ny, 0);
		push(b[0], b[1], T, nx, ny, 0);
		push(a[0], a[1], -T, nx, ny, 0);
		push(b[0], b[1], T, nx, ny, 0);
		push(a[0], a[1], T, nx, ny, 0);
	}
	return {
		positions: new Float32Array(pos),
		normals: new Float32Array(nrm),
		vertexCount: pos.length / 3,
	};
}

// --- replay-trail sphere mesh --------------------------------------------------------

/**
 * Flat-shaded unit sphere (UV sphere, coarse on purpose — it's a map dot).
 * True spheres for the loop replay trails (issue #242): the extrusion pucks were the
 * best fill-extrusion could do; the custom layer renders the real thing.
 */
export function buildSphereMesh(stacks = 8, slices = 12): PlaneMesh {
	const pos: number[] = [];
	const nrm: number[] = [];
	const vert = (i: number, j: number): [number, number, number] => {
		const theta = (i / stacks) * Math.PI; // 0 (north pole) → π (south pole)
		const phi = (j / slices) * 2 * Math.PI;
		return [
			Math.sin(theta) * Math.cos(phi),
			Math.sin(theta) * Math.sin(phi),
			Math.cos(theta),
		];
	};
	const pushTri = (
		a: [number, number, number],
		b: [number, number, number],
		c: [number, number, number],
	) => {
		// Flat face normal, pointing outward (centroid direction on a sphere).
		const nx = (a[0] + b[0] + c[0]) / 3;
		const ny = (a[1] + b[1] + c[1]) / 3;
		const nz = (a[2] + b[2] + c[2]) / 3;
		const len = Math.hypot(nx, ny, nz) || 1;
		for (const v of [a, b, c]) {
			pos.push(v[0], v[1], v[2]);
			nrm.push(nx / len, ny / len, nz / len);
		}
	};
	for (let i = 0; i < stacks; i++) {
		for (let j = 0; j < slices; j++) {
			const a = vert(i, j);
			const b = vert(i + 1, j);
			const c = vert(i + 1, j + 1);
			const d = vert(i, j + 1);
			// Pole rows collapse one quad edge to a point → single triangles.
			if (i > 0) pushTri(a, b, d);
			if (i < stacks - 1) pushTri(b, c, d);
		}
	}
	return {
		positions: new Float32Array(pos),
		normals: new Float32Array(nrm),
		vertexCount: pos.length / 3,
	};
}

// --- per-frame instances ------------------------------------------------------

// Two vec4 attributes per instance:
//   i_data0 = [mercX, mercY, elevExaggeratedMeters, mercatorUnitsPerMeter]
//   i_data1 = [headingRad, pitchRad, halfSizeMeters, notableFlag]
export const PLANE_INSTANCE_STRIDE = 8;

// Visual pitch clamp (~57°): real climb angles are shallow, so this rarely
// bites in normal flight — it guards against sparse/garbage samples that imply
// a near-vertical rate (e.g. a big altitude jump between two distant samples)
// reading as aerobatics.
const MAX_PITCH_RAD = 1.0;

/**
 * Nose attitude from the last two samples: atan2 of exaggerated vertical
 * speed over ground speed — positive nose-up while climbing. 0 when unknown.
 */
export function pitchRadOf(m: FlightMotion): number {
	if (m.trail.length < 2 || m.curT <= m.prevT) return 0;
	const [alon, alat, aalt] = m.trail[m.trail.length - 2];
	const [blon, blat, balt] = m.trail[m.trail.length - 1];
	const dtS = (m.curT - m.prevT) / 1000;
	const kmPerDegLat = 110.574;
	const kmPerDegLon = 111.32 * Math.max(Math.cos((blat * Math.PI) / 180), 0.01);
	const groundMps =
		(Math.hypot((blat - alat) * kmPerDegLat, (blon - alon) * kmPerDegLon) * 1000) / dtS;
	const vertMps = (exaggeratedHeightM(balt) - exaggeratedHeightM(aalt)) / dtS;
	if (groundMps === 0 && vertMps === 0) return 0;
	const pitch = Math.atan2(vertMps, Math.max(groundMps, 1));
	return Math.min(Math.max(pitch, -MAX_PITCH_RAD), MAX_PITCH_RAD);
}

export interface PlaneInstances {
	data: Float32Array;
	count: number;
	/** Parallel array: instance index → flight callsign (for hit-testing/debug). */
	flights: string[];
}

/**
 * Per-airframe batches: like buildPlaneInstances, but grouped by the model
 * family each flight should render as (aircraftModels.familyForAircraftType
 * via the route index). Families whose mesh hasn't loaded yet fall back to
 * the "default" prism inside the layer.
 */
export function buildPlaneInstanceBatches(
	buffer: MotionBuffer,
	now: number,
	sizeKm: number,
	familyOf: (m: FlightMotion) => string,
	landing?: LandingClock,
): { meshKey: string; data: Float32Array; count: number }[] {
	const groups = new Map<string, FlightMotion[]>();
	for (const m of buffer.values()) {
		const key = familyOf(m);
		let g = groups.get(key);
		if (!g) {
			g = [];
			groups.set(key, g);
		}
		g.push(m);
	}
	const halfSizeM = sizeKm * 500;
	const batches: { meshKey: string; data: Float32Array; count: number }[] = [];
	for (const [meshKey, motions] of groups) {
		const data = new Float32Array(motions.length * PLANE_INSTANCE_STRIDE);
		let count = 0;
		for (const m of motions) {
			const effNow = motionNow(m, now, landing);
			const altFt = altitudeFtAt(m, effNow);
			if (altFt <= 0) continue;
			const head = extrapolate(m, effNow);
			const [mx, my] = lngLatToMercator(head.lon, head.lat);
			const o = count * PLANE_INSTANCE_STRIDE;
			data[o] = mx;
			data[o + 1] = my;
			data[o + 2] = exaggeratedHeightM(altFt);
			data[o + 3] = mercatorPerMeter(head.lat);
			data[o + 4] = (m.headingDeg * Math.PI) / 180;
			data[o + 5] = pitchRadOf(m);
			data[o + 6] = halfSizeM;
			data[o + 7] = isNotable(m.item.flight) ? 1 : isObserver(m.item.flight) ? 2 : 0;
			count++;
		}
		if (count > 0) {
			batches.push({ meshKey, data: data.subarray(0, count * PLANE_INSTANCE_STRIDE), count });
		}
	}
	return batches;
}

/**
 * Pack every airborne flight into instance attributes at its glided position,
 * glided altitude, heading and pitch. sizeKm is the zoom-scaled marker size
 * (same value the extrusion path uses).
 */
export function buildPlaneInstances(
	buffer: MotionBuffer,
	now: number,
	sizeKm: number,
	landing?: LandingClock,
): PlaneInstances {
	const data = new Float32Array(buffer.size * PLANE_INSTANCE_STRIDE);
	const flights: string[] = [];
	let count = 0;
	const halfSizeM = sizeKm * 500; // local unit 1 = half the marker size
	for (const m of buffer.values()) {
		const effNow = motionNow(m, now, landing);
		const altFt = altitudeFtAt(m, effNow);
		if (altFt <= 0) continue;
		const head = extrapolate(m, effNow);
		const [mx, my] = lngLatToMercator(head.lon, head.lat);
		const o = count * PLANE_INSTANCE_STRIDE;
		data[o] = mx;
		data[o + 1] = my;
		data[o + 2] = exaggeratedHeightM(altFt);
		data[o + 3] = mercatorPerMeter(head.lat);
		data[o + 4] = (m.headingDeg * Math.PI) / 180;
		data[o + 5] = pitchRadOf(m);
		data[o + 6] = halfSizeM;
		data[o + 7] = isNotable(m.item.flight) ? 1 : isObserver(m.item.flight) ? 2 : 0;
		flights.push(m.item.flight);
		count++;
	}
	return { data: data.subarray(0, count * PLANE_INSTANCE_STRIDE), count, flights };
}
