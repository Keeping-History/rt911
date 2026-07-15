import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { updateMotion, type MotionBuffer } from "./flightMotion";
import {
	ALT_EXAGGERATION,
	FT_TO_M,
	TRAIL_3D_MAX_POINTS,
	altitudeFtAt,
	curtainToGeoJSON,
	exaggeratedHeightM,
	kmPerPixel,
	motionPlanes3DToGeoJSON,
	motionTrails3DToGeoJSON,
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
		// Heading 90° (due east): the nose apex must be the eastmost vertex,
		// on the same latitude as the center.
		const ring = planeRing(-74, 40, 90, 4);
		expect(ring[0]).toEqual(ring[ring.length - 1]);
		const east = ring.reduce((a, b) => (b[0] > a[0] ? b : a));
		expect(east[1]).toBeCloseTo(40, 6);
	});

	it("heading 0 keeps the nose apex due north of center", () => {
		const ring = planeRing(-74, 40, 0, 4);
		const north = ring.reduce((a, b) => (b[1] > a[1] ? b : a));
		expect(north[0]).toBeCloseTo(-74, 6);
		expect(north[1]).toBeGreaterThan(40);
	});

	it("matches the 2D icon's proportions (icon-derived, not a freehand shape)", () => {
		// plane.svg spans x 32..608, y 80..560 in a 640 box → forward extent
		// [-0.9, 0.9], lateral (wingspan) [-0.75, 0.75] on the unit grid.
		const ring = planeRing(0, 0, 0, 2); // heading north at equator, half = 1 km
		const lons = ring.map(([lon]) => lon);
		const lats = ring.map(([, lat]) => lat);
		expect(Math.max(...lats) * 110.574).toBeCloseTo(0.9, 3); // nose 0.9 fwd
		expect(Math.min(...lats) * 110.574).toBeCloseTo(-0.9, 3); // tail 0.9 aft
		expect(Math.max(...lons) * 111.32).toBeCloseTo(0.75, 3); // wingtip 0.75 lateral
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
		// 2px floor: hand-tuned (issue #245) so continental views stay airy —
		// solid 3D silhouettes carry far more ink than the 2D icons.
		expect(plane3DTargetPx(3)).toBe(2); // floor
		expect(plane3DTargetPx(7)).toBeGreaterThan(plane3DTargetPx(5));
		expect(plane3DTargetPx(13)).toBe(44); // ceiling
	});
});

describe("motionPlanes3DToGeoJSON", () => {
	it("cruise renders one whole-silhouette slab AT altitude", () => {
		const fc = motionPlanes3DToGeoJSON(bufferWith([{ flight: "DL404", alt_ft: 33_000 }]), 0, 4);
		expect(fc.features).toHaveLength(1);
		const f = fc.features[0];
		const base = 33_000 * FT_TO_M * ALT_EXAGGERATION;
		expect(f.properties!.flight).toBe("DL404");
		expect(f.properties!.notable).toBe(false);
		expect(f.properties!.base).toBeCloseTo(base, 0);
		expect((f.properties!.height as number) - (f.properties!.base as number)).toBeLessThan(
			base / 10,
		);
		const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
		expect(ring[0]).toEqual(ring[ring.length - 1]);
		expect(exaggeratedHeightM(33_000)).toBeCloseTo(100_584, 0);
	});

	it("climbing planes stay ONE whole silhouette — never sliced strips (issue #250)", () => {
		const buf: MotionBuffer = new Map();
		// Two minutes of eastbound climb: 10k → 14k ft over ~9 km of track.
		updateMotion(buf, [pos({ id: 1, flight: "UA1", lon: -74.1, alt_ft: 10_000, start_date: "2001-09-11T13:00:00Z" })]);
		updateMotion(buf, [pos({ id: 2, flight: "UA1", lon: -74.0, alt_ft: 14_000, start_date: "2001-09-11T13:01:00Z" })]);
		const fc = motionPlanes3DToGeoJSON(buf, Date.parse("2001-09-11T13:01:00Z"), 4);
		// Strip-banded "pitch" rendered climbs as sliced staircases; fill-
		// extrusion tops are flat, so the model stays level and whole (true
		// angling needs a custom WebGL layer — tracked separately).
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].properties!.base).toBeCloseTo(exaggeratedHeightM(14_000), 0);
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
		expect(fc.features).toHaveLength(1); // one slab per airborne plane; N1 grounded
		expect(fc.features[0].properties!.notable).toBe(true);
	});

	it("glides altitude between samples like position: no minute-step descents", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 1, flight: "DL9", lon: -74.1, alt_ft: 20_000, start_date: "2001-09-11T13:00:00Z" })]);
		updateMotion(buf, [pos({ id: 2, flight: "DL9", lon: -74.0, alt_ft: 10_000, start_date: "2001-09-11T13:01:00Z" })]);
		const t1 = Date.parse("2001-09-11T13:01:00Z");
		// 30s past the last sample at −10k ft/min → dead-reckoned to 5,000 ft.
		expect(altitudeFtAt(buf.get("DL9")!, t1 + 30_000)).toBeCloseTo(5_000, 5);
		// Clamped at MAX_EXTRAPOLATION_MS (90s → −15k → below ground) —
		// the plane feature drops out rather than tunneling.
		const far = motionPlanes3DToGeoJSON(buf, t1 + 10 * 60_000, 4);
		expect(far.features).toHaveLength(0);
		// And the rendered base at t1+30s uses the glided altitude.
		const fc = motionPlanes3DToGeoJSON(buf, t1 + 30_000, 4);
		expect(fc.features[0].properties!.base).toBeCloseTo(exaggeratedHeightM(5_000), 5);
	});
});

describe("motionTrails3DToGeoJSON", () => {
	it("each ribbon quad spans the pair's altitude range so climbs stay connected", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 1, flight: "UA1", lon: -74.1, alt_ft: 10_000, start_date: "2001-09-11T13:00:00Z" })]);
		updateMotion(buf, [pos({ id: 2, flight: "UA1", lon: -74.0, alt_ft: 20_000, start_date: "2001-09-11T13:01:00Z" })]);
		const now = Date.parse("2001-09-11T13:01:00Z");
		const fc = motionTrails3DToGeoJSON(buf, now, 20, 0.5);
		// 2 trail points + head (head == last sample at now) → 2 quads, but the
		// zero-length head segment is skipped → 1 ribbon quad.
		expect(fc.features).toHaveLength(1);
		const f = fc.features[0];
		// Vertical extent covers BOTH endpoints (min→max ± half thickness), so
		// consecutive quads meet at the shared point instead of hovering as
		// dissected mid-altitude blocks.
		expect(f.properties!.base).toBeLessThan(exaggeratedHeightM(10_000));
		expect(f.properties!.height).toBeGreaterThan(exaggeratedHeightM(20_000));
		const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
		expect(ring).toHaveLength(5);
		expect(ring[0]).toEqual(ring[4]);
	});

	it("caps ribbon points at TRAIL_3D_MAX_POINTS and honors tails-off", () => {
		expect(TRAIL_3D_MAX_POINTS).toBe(20);
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 1, flight: "UA1" })]);
		expect(motionTrails3DToGeoJSON(buf, 0, 0, 0.5).features).toHaveLength(0);
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
