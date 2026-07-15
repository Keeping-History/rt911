import type { PlaneMesh } from "./plane3dMesh";

// Per-family 3D aircraft models (issue #250 follow-up): every airframe family
// in flight_tracks maps to a marker-ready STL baked offline (stl-review/
// process_models.py — normalized nose→+Y, fin→+Z, length 1.8 local units,
// ≤6k triangles) and hosted at maps/aircraft/. models.json alongside carries
// license + attribution for each (all CC-BY/CC-BY-SA/GPL, recorded per file).

const MODEL_BASE_URL =
	(import.meta.env.VITE_AIRCRAFT_MODELS_URL as string | undefined) ??
	"https://files.911realtime.org/maps/aircraft";

export type AircraftFamily =
	| "generic" | "b737" | "b757" | "b767" | "b777" | "b727" | "md80"
	| "dc10" | "a319" | "a320" | "crj" | "erj" | "atr" | "bizjet" | "dc3";

// Ordered: first match wins. Patterns written against the exact strings in
// flight_tracks.aircraft_type (86 distinct values, see aircraftModels.test).
const FAMILY_PATTERNS: [RegExp, AircraftFamily][] = [
	[/757/, "b757"],
	[/767/, "b767"],
	[/777/, "b777"],
	[/727/, "b727"],
	[/737/, "b737"],
	[/717|DC-?9|DC9|MD[- ]?8\d|MD[- ]?9\d|MD 8\d/i, "md80"],
	[/DC-?10|MD-?11/i, "dc10"],
	[/A-?319/i, "a319"],
	[/A-?32[01]/i, "a320"],
	[/CL-?600|CRJ/i, "crj"],
	[/EMB|ERJ|Embraer/i, "erj"],
	[/ATR|SD3|Short/i, "atr"],
	[/DC-?3|C-47|DC-?7/i, "dc3"],
	// Bizjets and small props share one sleek-small silhouette.
	[/Gulfstream|G-?1159|Cessna|Citation|Aero Commander|Beech|Mitsubishi|MU-2/i, "bizjet"],
];

const familyCache = new Map<string, AircraftFamily>();

/** Airframe family for a flight_tracks.aircraft_type string. */
export function familyForAircraftType(type: string | null | undefined): AircraftFamily {
	if (!type) return "generic";
	const cached = familyCache.get(type);
	if (cached) return cached;
	let family: AircraftFamily = "generic";
	for (const [re, fam] of FAMILY_PATTERNS) {
		if (re.test(type)) {
			family = fam;
			break;
		}
	}
	familyCache.set(type, family);
	return family;
}

/**
 * Parse a binary STL into the layer's flat-shaded mesh shape. Normals are
 * recomputed from the triangle winding (files in the wild carry junk
 * normals). Throws on anything that isn't a well-formed binary STL.
 */
export function parseBinaryStl(buf: ArrayBuffer): PlaneMesh {
	const view = new DataView(buf);
	if (buf.byteLength < 84) throw new Error("not a binary STL: too short");
	const count = view.getUint32(80, true);
	if (buf.byteLength !== 84 + 50 * count) {
		throw new Error("not a binary STL: size mismatch");
	}
	const positions = new Float32Array(count * 9);
	const normals = new Float32Array(count * 9);
	for (let i = 0; i < count; i++) {
		const off = 84 + i * 50 + 12; // skip the stored normal
		for (let v = 0; v < 9; v++) {
			positions[i * 9 + v] = view.getFloat32(off + v * 4, true);
		}
		const p = i * 9;
		const ux = positions[p + 3] - positions[p];
		const uy = positions[p + 4] - positions[p + 1];
		const uz = positions[p + 5] - positions[p + 2];
		const wx = positions[p + 6] - positions[p];
		const wy = positions[p + 7] - positions[p + 1];
		const wz = positions[p + 8] - positions[p + 2];
		let nx = uy * wz - uz * wy;
		let ny = uz * wx - ux * wz;
		let nz = ux * wy - uy * wx;
		const len = Math.hypot(nx, ny, nz) || 1;
		nx /= len;
		ny /= len;
		nz /= len;
		for (let v = 0; v < 3; v++) {
			normals[p + v * 3] = nx;
			normals[p + v * 3 + 1] = ny;
			normals[p + v * 3 + 2] = nz;
		}
	}
	return { positions, normals, vertexCount: count * 3 };
}

// One in-flight/settled promise per family; failures resolve null so a bad
// asset degrades to the icon-derived prism rather than retry-storming.
const meshPromises = new Map<AircraftFamily, Promise<PlaneMesh | null>>();

/** Fetch + parse a family's model, cached forever (assets are immutable). */
export function loadAircraftMesh(family: AircraftFamily): Promise<PlaneMesh | null> {
	let p = meshPromises.get(family);
	if (!p) {
		p = fetch(`${MODEL_BASE_URL}/${family}.stl`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return parseBinaryStl(await res.arrayBuffer());
			})
			.catch((err: unknown) => {
				console.warn(`aircraft model ${family} unavailable:`, err);
				return null;
			});
		meshPromises.set(family, p);
	}
	return p;
}

/** Test seam: forget cached loads (jsdom tests stub fetch per case). */
export function resetAircraftMeshCache(): void {
	meshPromises.clear();
}
