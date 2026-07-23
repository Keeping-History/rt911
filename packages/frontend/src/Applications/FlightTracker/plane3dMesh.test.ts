import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { updateMotion, type MotionBuffer } from "./flightMotion";
import { PLANE_SHAPE, exaggeratedHeightM } from "./flightAltitude";
import {
	PLANE_INSTANCE_STRIDE,
	PLANE_MESH_HALF_THICKNESS,
	buildPlaneInstances,
	buildPlaneMesh,
	buildSphereMesh,
	lngLatToMercator,
	mercatorPerMeter,
	pitchRadOf,
	triangulate,
} from "./plane3dMesh";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "DL404", start_date: "2001-09-11T13:00:00Z",
	lat: 40, lon: -74, alt_ft: 33_000, ...over,
});

describe("lngLatToMercator / mercatorPerMeter", () => {
	it("maps the known anchors of web mercator", () => {
		expect(lngLatToMercator(0, 0)).toEqual([0.5, 0.5]);
		expect(lngLatToMercator(-180, 0)[0]).toBe(0);
		const [, yNorth] = lngLatToMercator(0, 60);
		expect(yNorth).toBeLessThan(0.5); // y grows southward
	});

	it("scale grows toward the poles (fewer real meters per mercator unit)", () => {
		expect(mercatorPerMeter(60)).toBeCloseTo(2 * mercatorPerMeter(0), 10);
	});
});

describe("triangulate (ear clipping)", () => {
	function ringArea(ring: [number, number][]): number {
		let a = 0;
		for (let i = 0; i < ring.length; i++) {
			const [x1, y1] = ring[i];
			const [x2, y2] = ring[(i + 1) % ring.length];
			a += x1 * y2 - x2 * y1;
		}
		return Math.abs(a / 2);
	}
	function triArea(a: [number, number], b: [number, number], c: [number, number]): number {
		return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
	}

	it("covers the concave plane silhouette exactly (area conservation)", () => {
		const ring = PLANE_SHAPE.slice(0, -1) as [number, number][];
		const tris = triangulate(ring);
		expect(tris.length % 3).toBe(0);
		expect(tris.length / 3).toBe(ring.length - 2); // full triangulation
		let sum = 0;
		for (let i = 0; i < tris.length; i += 3) {
			sum += triArea(ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]]);
		}
		expect(sum).toBeCloseTo(ringArea(ring), 8);
	});
});

describe("buildPlaneMesh", () => {
	const mesh = buildPlaneMesh();

	it("is a closed flat-shaded prism of the silhouette", () => {
		const ringVerts = PLANE_SHAPE.length - 1;
		const capTris = (ringVerts - 2) * 2; // top + bottom
		const sideTris = ringVerts * 2;
		expect(mesh.vertexCount).toBe((capTris + sideTris) * 3);
		expect(mesh.positions).toHaveLength(mesh.vertexCount * 3);
		expect(mesh.normals).toHaveLength(mesh.vertexCount * 3);
	});

	it("z extents match the slab half-thickness and normals are unit length", () => {
		let minZ = Infinity;
		let maxZ = -Infinity;
		for (let i = 2; i < mesh.positions.length; i += 3) {
			minZ = Math.min(minZ, mesh.positions[i]);
			maxZ = Math.max(maxZ, mesh.positions[i]);
		}
		expect(minZ).toBeCloseTo(-PLANE_MESH_HALF_THICKNESS, 6);
		expect(maxZ).toBeCloseTo(PLANE_MESH_HALF_THICKNESS, 6);
		for (let i = 0; i < mesh.normals.length; i += 3) {
			const len = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
			expect(len).toBeCloseTo(1, 5);
		}
	});
});

describe("buildSphereMesh", () => {
	const mesh = buildSphereMesh();

	it("is whole flat-shaded triangles with every vertex on the unit sphere", () => {
		expect(mesh.vertexCount).toBeGreaterThan(0);
		expect(mesh.vertexCount % 3).toBe(0);
		expect(mesh.positions).toHaveLength(mesh.vertexCount * 3);
		expect(mesh.normals).toHaveLength(mesh.vertexCount * 3);
		for (let i = 0; i < mesh.positions.length; i += 3) {
			const r = Math.hypot(
				mesh.positions[i],
				mesh.positions[i + 1],
				mesh.positions[i + 2],
			);
			expect(r).toBeCloseTo(1, 5);
		}
	});

	it("spans pole to pole so it reads as a ball, not a band", () => {
		let minZ = Infinity;
		let maxZ = -Infinity;
		for (let i = 2; i < mesh.positions.length; i += 3) {
			minZ = Math.min(minZ, mesh.positions[i]);
			maxZ = Math.max(maxZ, mesh.positions[i]);
		}
		expect(minZ).toBeCloseTo(-1, 5);
		expect(maxZ).toBeCloseTo(1, 5);
	});

	it("normals are unit length and point outward", () => {
		for (let i = 0; i < mesh.normals.length; i += 3) {
			const [nx, ny, nz] = [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]];
			expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
			const dot =
				nx * mesh.positions[i] + ny * mesh.positions[i + 1] + nz * mesh.positions[i + 2];
			expect(dot).toBeGreaterThan(0);
		}
	});
});

describe("pitchRadOf", () => {
	function climbBuffer(altA: number, altB: number): MotionBuffer {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 1, flight: "UA1", lon: -74.1, alt_ft: altA, start_date: "2001-09-11T13:00:00Z" })]);
		updateMotion(buf, [pos({ id: 2, flight: "UA1", lon: -74.0, alt_ft: altB, start_date: "2001-09-11T13:01:00Z" })]);
		return buf;
	}

	it("is positive nose-up on climbs, negative on descents, zero level/unknown", () => {
		expect(pitchRadOf(climbBuffer(10_000, 14_000).get("UA1")!)).toBeGreaterThan(0);
		expect(pitchRadOf(climbBuffer(14_000, 10_000).get("UA1")!)).toBeLessThan(0);
		expect(pitchRadOf(climbBuffer(31_000, 31_000).get("UA1")!)).toBe(0);
		const single: MotionBuffer = new Map();
		updateMotion(single, [pos({})]);
		expect(pitchRadOf(single.get("DL404")!)).toBe(0);
	});

	it("clamps to ±1 rad for a near-vertical rate (sparse/garbage samples)", () => {
		// No horizontal movement (same lon) → ground speed ~0, so even real-scale
		// altitude produces an absurd pitch that must clamp. This is the sample-
		// quality guard, not exaggeration: a plain climb no longer saturates it.
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 1, flight: "UA1", lon: -74, alt_ft: 0, start_date: "2001-09-11T13:00:00Z" })]);
		updateMotion(buf, [pos({ id: 2, flight: "UA1", lon: -74, alt_ft: 35_000, start_date: "2001-09-11T13:01:00Z" })]);
		expect(pitchRadOf(buf.get("UA1")!)).toBe(1);
	});
});

describe("buildPlaneInstances", () => {
	it("packs mercator position, glided altitude, attitude and notability", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [
			pos({ id: 1, flight: "AA11", lat: 40, lon: -74, alt_ft: 20_000 }),
			pos({ id: 2, flight: "TAXI", alt_ft: 0 }), // grounded → skipped
		]);
		const now = Date.parse("2001-09-11T13:00:00Z");
		const inst = buildPlaneInstances(buf, now, 4);
		expect(inst.count).toBe(1);
		expect(inst.flights).toEqual(["AA11"]);
		expect(inst.data).toHaveLength(PLANE_INSTANCE_STRIDE);
		const [mx, my, elev, mpm, heading, pitch, halfSize, notable] = inst.data;
		const [ex, ey] = lngLatToMercator(-74, 40);
		expect(mx).toBeCloseTo(ex, 6);
		expect(my).toBeCloseTo(ey, 6);
		expect(elev).toBeCloseTo(exaggeratedHeightM(20_000), 0);
		expect(mpm).toBeCloseTo(mercatorPerMeter(40), 12);
		expect(heading).toBe(0); // single sample: no movement yet
		expect(pitch).toBe(0);
		expect(halfSize).toBe(2_000); // sizeKm 4 → half size 2 km in meters
		expect(notable).toBe(1);
	});
});
