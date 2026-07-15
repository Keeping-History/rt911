import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { updateMotion, type MotionBuffer } from "./flightMotion";
import {
	ALT_EXAGGERATION,
	FT_TO_M,
	curtainToGeoJSON,
	exaggeratedHeightM,
	kmPerPixel,
	motionPlanes3DToGeoJSON,
	plane3DTargetPx,
	planeRing,
} from "./flightAltitude";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "DL404", start_date: "2001-09-11T13:00:00Z",
	lat: 40, lon: -74, alt_ft: 33_000, ...over,
});

function bufferWith(items: Partial<FlightPosition>[]): MotionBuffer {
	const buf: MotionBuffer = new Map();
	updateMotion(buf, items.map((o, i) => pos({ id: i + 1, ...o })));
	return buf;
}

describe("planeRing", () => {
	it("closes the ring and rotates the nose toward the heading", () => {
		// Heading 90° (due east): the nose vertex must be the eastmost point,
		// on the same latitude as the center.
		const ring = planeRing(-74, 40, 90, 4);
		expect(ring[0]).toEqual(ring[ring.length - 1]);
		const nose = ring[0];
		expect(Math.max(...ring.map(([lon]) => lon))).toBe(nose[0]);
		expect(nose[1]).toBeCloseTo(40, 6);
	});

	it("heading 0 keeps the nose due north", () => {
		const ring = planeRing(-74, 40, 0, 4);
		expect(ring[0][0]).toBeCloseTo(-74, 6);
		expect(ring[0][1]).toBeGreaterThan(40);
	});
});

describe("kmPerPixel", () => {
	it("halves per zoom level and shrinks with latitude", () => {
		expect(kmPerPixel(5, 0)).toBeCloseTo(kmPerPixel(4, 0) / 2, 6);
		expect(kmPerPixel(5, 60)).toBeLessThan(kmPerPixel(5, 0));
	});
});

describe("plane3DTargetPx", () => {
	it("grows the on-screen marker as you zoom in, clamped at both ends", () => {
		expect(plane3DTargetPx(3)).toBe(16); // floor
		expect(plane3DTargetPx(7)).toBeGreaterThan(plane3DTargetPx(5));
		expect(plane3DTargetPx(12)).toBe(44); // ceiling
	});
});

describe("motionPlanes3DToGeoJSON", () => {
	it("emits one plane slab per flight floating at its exaggerated altitude", () => {
		const fc = motionPlanes3DToGeoJSON(bufferWith([{ flight: "DL404", alt_ft: 33_000 }]), 0, 4);
		expect(fc.features).toHaveLength(1);
		const f = fc.features[0];
		expect(f.properties!.flight).toBe("DL404");
		expect(f.properties!.notable).toBe(false);
		const base = 33_000 * FT_TO_M * ALT_EXAGGERATION;
		expect(f.properties!.base).toBeCloseTo(base, 0);
		// A thin slab AT altitude, not a column from the ground.
		expect(f.properties!.height).toBeGreaterThan(base);
		expect(f.properties!.height - (f.properties!.base as number)).toBeLessThan(base / 10);
		expect(exaggeratedHeightM(33_000)).toBeCloseTo(100_584, 0);
	});

	it("marks notables and skips grounded flights", () => {
		const fc = motionPlanes3DToGeoJSON(
			bufferWith([
				{ flight: "AA11", alt_ft: 26_000 },
				{ flight: "N1", alt_ft: 0 },
			]),
			0,
			4,
		);
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].properties!.notable).toBe(true);
	});
});

describe("curtainToGeoJSON", () => {
	const sample = (lon: number, lat: number, alt_ft: number) => ({
		lon, lat, alt_ft, utc: "2001-09-11T13:00:00Z",
	});

	it("builds closed quads whose tops ramp between the samples' altitudes", () => {
		const fc = curtainToGeoJSON([
			sample(-74, 40, 10_000),
			sample(-73.9, 40.1, 20_000),
		]);
		// A 10k ft climb subdivides into altitude-lerped sub-quads (no blocky
		// single step); heights are strictly increasing along the ramp and
		// bracketed by the endpoint altitudes.
		expect(fc.features.length).toBeGreaterThan(2);
		const heights = fc.features.map((f) => f.properties!.height as number);
		for (let i = 1; i < heights.length; i++) {
			expect(heights[i]).toBeGreaterThan(heights[i - 1]);
		}
		expect(heights[0]).toBeGreaterThan(exaggeratedHeightM(10_000));
		expect(heights[heights.length - 1]).toBeLessThan(exaggeratedHeightM(20_000));
		for (const f of fc.features) {
			const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
			expect(ring).toHaveLength(5);
			expect(ring[0]).toEqual(ring[4]);
		}
	});

	it("level cruise stays a single quad per pair (no wasted subdivisions)", () => {
		const fc = curtainToGeoJSON([
			sample(-74, 40, 31_000),
			sample(-73.9, 40.1, 31_000),
		]);
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].properties!.height).toBeCloseTo(exaggeratedHeightM(31_000), 5);
	});

	it("returns an empty FC for null or single-sample profiles", () => {
		expect(curtainToGeoJSON(null).features).toEqual([]);
		expect(curtainToGeoJSON([sample(-74, 40, 10_000)]).features).toEqual([]);
	});
});
