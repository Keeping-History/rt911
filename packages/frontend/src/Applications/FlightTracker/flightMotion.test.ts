import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import {
	MAX_EXTRAPOLATION_MS,
	TAIL_MS,
	type MotionBuffer,
	extrapolate,
	motionPointsToGeoJSON,
	motionTrailsToGeoJSON,
	tailSegment,
	updateMotion,
	velocityOf,
} from "./flightMotion";

const T0 = Date.parse("2001-09-11T13:00:00.000Z");
const T1 = T0 + 60_000; // one minute later

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "AA1", start_date: "2001-09-11T13:00:00.000Z",
	lat: 40, lon: -74, alt_ft: 30000, ...over,
});

describe("updateMotion", () => {
	it("seeds an unseen flight with prev == cur (static, keyed by callsign)", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 10, flight: "AA1", lat: 40, lon: -74 })]);
		const m = buf.get("AA1")!;
		expect(m.prev).toEqual(m.cur);
		expect(m.curT).toBe(T0);
		expect(m.item.id).toBe(10);
	});

	it("shifts cur→prev on a newer sample (different id, same callsign)", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ id: 10, flight: "AA1", lon: -74, start_date: "2001-09-11T13:00:00.000Z" })]);
		updateMotion(buf, [pos({ id: 11, flight: "AA1", lon: -73, start_date: "2001-09-11T13:01:00.000Z" })]);
		const m = buf.get("AA1")!;
		expect(m.prev).toEqual({ lat: 40, lon: -74 });
		expect(m.cur).toEqual({ lat: 40, lon: -73 });
		expect(m.prevT).toBe(T0);
		expect(m.curT).toBe(T1);
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
		updateMotion(buf, [pos({ flight: "AA1", lon: -74, start_date: "2001-09-11T13:00:00.000Z" })]);
		updateMotion(buf, [pos({ flight: "AA1", lon: -73, start_date: "2001-09-11T13:01:00.000Z" })]);
		// +1 lon over 60_000 ms → 30_000 ms past the last sample = +0.5 lon
		const head = extrapolate(buf.get("AA1")!, T1 + 30_000);
		expect(head.lon).toBeCloseTo(-72.5, 6);
		expect(head.lat).toBeCloseTo(40, 6);
	});

	it("clamps extrapolation to MAX_EXTRAPOLATION_MS", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ flight: "AA1", lon: -74, start_date: "2001-09-11T13:00:00.000Z" })]);
		updateMotion(buf, [pos({ flight: "AA1", lon: -73, start_date: "2001-09-11T13:01:00.000Z" })]);
		// far in the future → clamped at 90_000 ms = +1.5 lon
		const head = extrapolate(buf.get("AA1")!, T1 + 10 * 60_000);
		expect(head.lon).toBeCloseTo(-73 + 1.5, 6);
		expect(MAX_EXTRAPOLATION_MS).toBe(90_000);
	});
});

describe("tailSegment", () => {
	it("returns null for a static flight", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ flight: "AA1" })]);
		expect(tailSegment(buf.get("AA1")!, T0)).toBeNull();
	});

	it("is a [tail,head] segment ending at the head, pointing along travel", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ flight: "AA1", lon: -74, start_date: "2001-09-11T13:00:00.000Z" })]);
		updateMotion(buf, [pos({ flight: "AA1", lon: -73, start_date: "2001-09-11T13:01:00.000Z" })]);
		const seg = tailSegment(buf.get("AA1")!, T1)!; // now == last sample → head at -73
		expect(seg).not.toBeNull();
		const [tail, head] = seg;
		expect(head).toEqual([-73, 40]); // [lon,lat]
		// tail is TAIL_MS behind along velocity: -73 - (1/60000)*120000 = -75
		expect(tail[0]).toBeCloseTo(-75, 6);
		expect(TAIL_MS).toBe(120_000);
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

	it("motionTrailsToGeoJSON emits one LineString per moving flight, none for static", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [pos({ flight: "AA1", lon: -74, start_date: "2001-09-11T13:00:00.000Z" })]);
		updateMotion(buf, [pos({ flight: "AA1", lon: -73, start_date: "2001-09-11T13:01:00.000Z" })]);
		updateMotion(buf, [
			pos({ flight: "AA1", lon: -73, start_date: "2001-09-11T13:01:00.000Z" }),
			pos({ flight: "STATIC", lon: -80, start_date: "2001-09-11T13:01:00.000Z" }),
		]);
		const fc = motionTrailsToGeoJSON(buf, T1);
		const flights = fc.features.length;
		expect(flights).toBe(1); // AA1 moving; STATIC seeded this tick → no velocity
		expect(fc.features[0].geometry.type).toBe("LineString");
	});
});
