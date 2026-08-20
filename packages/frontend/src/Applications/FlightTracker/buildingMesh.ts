import { lngLatToMercator, mercatorPerMeter, triangulate, type PlaneMesh } from "./plane3dMesh";

// Pure geometry for the 2001 buildings layer. Footprint polygons and placed STL
// hero meshes are baked into ONE vertex format the custom layer draws directly:
//   positions (stride 4): mercX, mercY, elevMeters, mercPerMeter
//   normals   (stride 3): east, north, up   (shading frame; independent of the
//                          mercator y-flip since it is only dotted with a fixed
//                          light, never projected)
// The vertex shader projects each vertex via projectTileFor3D(pos.xy, elev),
// using pos.w (mercPerMeter) to convert meters->mercator units under mercator.

export interface BuildingMesh {
	positions: Float32Array;
	normals: Float32Array;
	vertexCount: number;
}

export interface BuildingFootprint {
	ring: [number, number][]; // outer ring [lng, lat], OPEN (no closing dup)
	baseElevM: number;
	heightM: number;
}

const EPS = 1e-12;

/** Shoelace sign in lng/lat (east=x, north=y): CCW => positive. */
export function ringIsCcwLngLat(ring: [number, number][]): boolean {
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x1, y1] = ring[i];
		const [x2, y2] = ring[(i + 1) % ring.length];
		area += x1 * y2 - x2 * y1;
	}
	return area >= 0;
}

/** Build the combined roof-cap + wall mesh for a set of footprints. */
export function buildFootprintMesh(features: BuildingFootprint[]): BuildingMesh {
	const pos: number[] = [];
	const nrm: number[] = [];

	const pushVert = (
		lng: number, lat: number, elev: number,
		nEast: number, nNorth: number, nUp: number,
	) => {
		const [mx, my] = lngLatToMercator(lng, lat);
		pos.push(mx, my, elev, mercatorPerMeter(lat));
		nrm.push(nEast, nNorth, nUp);
	};

	for (const f of features) {
		// Drop a repeated closing vertex if the source left one in.
		let ring = f.ring;
		if (ring.length > 1) {
			const [x0, y0] = ring[0];
			const [xn, yn] = ring[ring.length - 1];
			if (Math.abs(x0 - xn) < EPS && Math.abs(y0 - yn) < EPS) ring = ring.slice(0, -1);
		}
		if (ring.length < 3) continue;
		// Orient CCW so roof triangulation reads top-up and wall normals face out.
		const ccw = ringIsCcwLngLat(ring) ? ring : [...ring].reverse();
		const roofElev = f.baseElevM + f.heightM;

		// Roof cap: triangulate the ring, emit at roofElev, normal +up.
		const tris = triangulate(ccw);
		for (let i = 0; i < tris.length; i += 3) {
			for (const idx of [tris[i], tris[i + 1], tris[i + 2]]) {
				const [lng, lat] = ccw[idx];
				pushVert(lng, lat, roofElev, 0, 0, 1);
			}
		}

		// Walls: one quad (two tris) per edge. Outward normal for a CCW ring is
		// (dNorth, -dEast) in the (east, north) plane, up = 0.
		for (let i = 0; i < ccw.length; i++) {
			const a = ccw[i];
			const b = ccw[(i + 1) % ccw.length];
			// Outward normal in the (east, north) metric plane. Longitude degrees
			// cover cos(lat)x less ground than latitude degrees, so scale the east
			// delta before taking the perpendicular -- otherwise diagonal walls get a
			// skewed shading normal.
			const latRad = (((a[1] + b[1]) / 2) * Math.PI) / 180;
			const dEast = (b[0] - a[0]) * Math.cos(latRad);
			const dNorth = b[1] - a[1];
			const len = Math.hypot(dEast, dNorth);
			if (len < EPS) continue;
			const nE = dNorth / len;
			const nN = -dEast / len;
			// Two triangles: (a_base, b_base, b_roof) and (a_base, b_roof, a_roof).
			pushVert(a[0], a[1], f.baseElevM, nE, nN, 0);
			pushVert(b[0], b[1], f.baseElevM, nE, nN, 0);
			pushVert(b[0], b[1], roofElev, nE, nN, 0);
			pushVert(a[0], a[1], f.baseElevM, nE, nN, 0);
			pushVert(b[0], b[1], roofElev, nE, nN, 0);
			pushVert(a[0], a[1], roofElev, nE, nN, 0);
		}
	}

	return {
		positions: new Float32Array(pos),
		normals: new Float32Array(nrm),
		vertexCount: pos.length / 4,
	};
}

export interface HeroPlacement {
	lng: number;
	lat: number;
	bearingDeg: number; // clockwise from north
	scale: number;      // multiplies the STL's local meters
	baseElevM: number;
}

/**
 * Transform an STL mesh (local meters, +Y north, +Z up) into building-vertex
 * format placed at lng/lat, rotated by bearing (clockwise from north), scaled,
 * and seated at base elevation. All vertices of one hero share the anchor's
 * mercatorPerMeter (a hero spans a few hundred meters — latitude is constant).
 */
export function placeHeroMesh(stl: PlaneMesh, place: HeroPlacement): BuildingMesh {
	const [ax, ay] = lngLatToMercator(place.lng, place.lat);
	const perM = mercatorPerMeter(place.lat);
	const ch = Math.cos((place.bearingDeg * Math.PI) / 180);
	const sh = Math.sin((place.bearingDeg * Math.PI) / 180);
	const n = stl.vertexCount;
	const positions = new Float32Array(n * 4);
	const normals = new Float32Array(n * 3);

	for (let i = 0; i < n; i++) {
		// Local meters (x east, y north, z up), scaled.
		const lx = stl.positions[i * 3] * place.scale;
		const ly = stl.positions[i * 3 + 1] * place.scale;
		const lz = stl.positions[i * 3 + 2] * place.scale;
		// Bearing rotation about up: clockwise from north (matches plane heading).
		const east = lx * ch + ly * sh;
		const north = -lx * sh + ly * ch;
		// East/north meters -> mercator (y grows south, so north subtracts).
		positions[i * 4] = ax + east * perM;
		positions[i * 4 + 1] = ay - north * perM;
		positions[i * 4 + 2] = place.baseElevM + lz;
		positions[i * 4 + 3] = perM;
		// Rotate the normal the same way; keep it in the (east, north, up) frame.
		const nx = stl.normals[i * 3];
		const ny = stl.normals[i * 3 + 1];
		normals[i * 3] = nx * ch + ny * sh;
		normals[i * 3 + 1] = -nx * sh + ny * ch;
		normals[i * 3 + 2] = stl.normals[i * 3 + 2];
	}
	return { positions, normals, vertexCount: n };
}
