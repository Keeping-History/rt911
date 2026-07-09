import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import {
	MAX_EXTRAPOLATION_MS,
	type MotionBuffer,
	TRAIL_POINTS,
	extrapolate,
	motionPointsToGeoJSON,
	motionTrailsToGeoJSON,
	updateMotion,
	velocityOf,
} from "./flightMotion";

const T0 = Date.parse("2001-09-11T13:00:00.000Z");
const T1 = T0 + 60_000; // one minute later

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "AA1", start_date: "2001-09-11T13:00:00.000Z",
	lat: 40, lon: -74, alt_ft: 30000, ...over,
});

// A per-minute sample for a flight at minute `min` past T0, at longitude `lon`.
const sampleAt = (min: number, lon: number, flight = "AA1"): FlightPosition =>
	pos({ id: 100 + min, flight, lon, start_date: new Date(T0 + min * 60_000).toISOString() });

describe("updateMotion", () => {
	it("seeds an unseen flight with prev == cur and a single trail point", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 10, flight: "AA1", lat: 40, lon: -74 })]);
		const m = buf.get("AA1")!;
		expect(m.prev).toEqual(m.cur);
		expect(m.curT).toBe(T0);
		expect(m.item.id).toBe(10);
		expect(m.trail).toEqual([[-74, 40]]);
	});

	it("shifts cur→prev on a newer sample and appends [lon,lat] to the trail", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [sampleAt(0, -74)]);
		updateMotion(buf, [sampleAt(1, -73)]);
		const m = buf.get("AA1")!;
		expect(m.prev).toEqual({ lat: 40, lon: -74 });
		expect(m.cur).toEqual({ lat: 40, lon: -73 });
		expect(m.prevT).toBe(T0);
		expect(m.curT).toBe(T1);
		expect(m.trail).toEqual([
			[-74, 40],
			[-73, 40],
		]);
	});

	it("caps the trail at TRAIL_POINTS, dropping the oldest", () => {
		const buf: MotionBuffer = new Map();
		for (let min = 0; min <= TRAIL_POINTS + 3; min++) updateMotion(buf, [sampleAt(min, -74 + min)]);
		const m = buf.get("AA1")!;
		expect(TRAIL_POINTS).toBe(10);
		expect(m.trail).toHaveLength(TRAIL_POINTS);
		// After 14 samples (min 0..13), the oldest 4 are dropped: oldest kept is min 4.
		expect(m.trail[0]).toEqual([-70, 40]);
		expect(m.trail[m.trail.length - 1]).toEqual([-74 + (TRAIL_POINTS + 3), 40]);
	});

	it("does not append to the trail on a same/older sample", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [sampleAt(0, -74)]);
		updateMotion(buf, [sampleAt(1, -73)]);
		updateMotion(buf, [sampleAt(1, -73)]); // same timestamp again
		expect(buf.get("AA1")!.trail).toHaveLength(2);
	});

	it("prunes flights no longer in the snapshot", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ flight: "AA1" }), pos({ flight: "UA2" })]);
		updateMotion(buf, [pos({ flight: "AA1" })]);
		expect(buf.has("AA1")).toBe(true);
		expect(buf.has("UA2")).toBe(false);
	});
});

describe("velocityOf / extrapolate", () => {
	it("is zero for a single-sample (seeded) flight", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ flight: "AA1" })]);
		expect(velocityOf(buf.get("AA1")!)).toEqual({ vlat: 0, vlon: 0 });
	});

	it("extrapolates forward linearly along the last segment", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [sampleAt(0, -74)]);
		updateMotion(buf, [sampleAt(1, -73)]);
		// +1 lon over 60_000 ms → 30_000 ms past the last sample = +0.5 lon
		const head = extrapolate(buf.get("AA1")!, T1 + 30_000);
		expect(head.lon).toBeCloseTo(-72.5, 6);
		expect(head.lat).toBeCloseTo(40, 6);
	});

	it("clamps extrapolation to MAX_EXTRAPOLATION_MS", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [sampleAt(0, -74)]);
		updateMotion(buf, [sampleAt(1, -73)]);
		// far in the future → clamped at 90_000 ms = +1.5 lon
		const head = extrapolate(buf.get("AA1")!, T1 + 10 * 60_000);
		expect(head.lon).toBeCloseTo(-73 + 1.5, 6);
		expect(MAX_EXTRAPOLATION_MS).toBe(90_000);
	});
});

describe("GeoJSON builders", () => {
	it("motionPointsToGeoJSON emits [lon,lat] head points with reused properties + notable flag", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 7, flight: "AA11", carrier: "AA", lon: -74 })]);
		const fc = motionPointsToGeoJSON(buf, T0);
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].geometry.coordinates).toEqual([-74, 40]);
		expect(fc.features[0].properties.notable).toBe(true); // AA11 is notable
		expect(fc.features[0].properties.carrier).toBe("AA");
	});

	it("motionTrailsToGeoJSON emits the real breadcrumb + gliding head, none for single-sample", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [sampleAt(0, -74)]);
		updateMotion(buf, [sampleAt(1, -73)]);
		updateMotion(buf, [
			sampleAt(2, -72),
			pos({ flight: "NEW", id: 999, start_date: new Date(T0 + 2 * 60_000).toISOString() }),
		]);
		// now == last sample time → head == cur (static extrapolation), so head == last real point
		const fc = motionTrailsToGeoJSON(buf, T0 + 2 * 60_000);
		expect(fc.features).toHaveLength(1); // AA1 has 3 trail points; NEW is single-sample → skipped
		const coords = fc.features[0].geometry.coordinates;
		expect(coords.length).toBeGreaterThanOrEqual(4); // 3 trail points + head
		expect(coords[0]).toEqual([-74, 40]); // oldest first (fades transparent)
		expect(coords[coords.length - 1]).toEqual([-72, 40]); // head last (opaque)
		expect(fc.features[0].geometry.type).toBe("LineString");
	});

	it("motionTrailsToGeoJSON extends the breadcrumb to the extrapolated head while gliding", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [sampleAt(0, -74)]);
		updateMotion(buf, [sampleAt(1, -73)]);
		// 30s past the last sample → head glides to lon -72.5, beyond the last real point (-73)
		const fc = motionTrailsToGeoJSON(buf, T1 + 30_000);
		const coords = fc.features[0].geometry.coordinates;
		expect(coords[coords.length - 1][0]).toBeCloseTo(-72.5, 6);
	});
});
