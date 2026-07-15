import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import {
	buildReplayTrailInstances,
	insertReplaySamples,
	pruneReplay,
	type ReplayBuffer,
	replayTrails3DAt,
	replayPointsAt,
} from "./flightReplay";
import { exaggeratedHeightM } from "./flightAltitude";
import { PLANE_INSTANCE_STRIDE, lngLatToMercator, mercatorPerMeter } from "./plane3dMesh";

const T0 = Date.parse("2001-09-11T12:00:00Z");
const MIN = 60_000;

function pos(over: Partial<FlightPosition>): FlightPosition {
	return {
		id: 1,
		flight: "DL100",
		start_date: "2001-09-11T12:00:00Z",
		lat: 40,
		lon: -74,
		alt_ft: 30000,
		...over,
	};
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

describe("insertReplaySamples", () => {
	it("keeps samples sorted when inserted out of order", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ id: 2, start_date: iso(T0 + 2 * MIN), lat: 42 }),
			pos({ id: 1, start_date: iso(T0), lat: 40 }),
			pos({ id: 3, start_date: iso(T0 + MIN), lat: 41 }),
		]);
		const samples = buf.get("DL100")!.samples;
		expect(samples.map((s) => s.lat)).toEqual([40, 41, 42]);
	});

	it("is idempotent: re-inserting the same batch adds nothing", () => {
		const buf: ReplayBuffer = new Map();
		const batch = [pos({ id: 1 }), pos({ id: 2, start_date: iso(T0 + MIN) })];
		insertReplaySamples(buf, batch);
		insertReplaySamples(buf, batch);
		expect(buf.get("DL100")!.samples).toHaveLength(2);
	});

	it("marks notable flights", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [pos({ flight: "AA11" })]);
		expect(buf.get("AA11")!.props.notable).toBe(true);
		expect(buf.get("DL100")).toBeUndefined();
	});
});

describe("replayPointsAt", () => {
	it("interpolates linearly between bracketing samples", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ id: 1, start_date: iso(T0), lat: 40, lon: -74 }),
			pos({ id: 2, start_date: iso(T0 + MIN), lat: 41, lon: -73 }),
		]);
		const fc = replayPointsAt(buf, T0 + MIN / 2);
		expect(fc.features).toHaveLength(1);
		const [lon, lat] = fc.features[0].geometry.coordinates;
		expect(lat).toBeCloseTo(40.5);
		expect(lon).toBeCloseTo(-73.5);
	});

	it("returns the exact sample when the playhead lands on one", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ id: 1, start_date: iso(T0), lat: 40 }),
			pos({ id: 2, start_date: iso(T0 + MIN), lat: 41 }),
		]);
		const fc = replayPointsAt(buf, T0 + MIN);
		expect(fc.features[0].geometry.coordinates[1]).toBeCloseTo(41);
	});

	it("omits flights outside their sampled lifetime (no extrapolation)", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ id: 1, start_date: iso(T0 + 10 * MIN) }),
			pos({ id: 2, start_date: iso(T0 + 12 * MIN) }),
		]);
		expect(replayPointsAt(buf, T0 + 9 * MIN).features).toHaveLength(0);
		expect(replayPointsAt(buf, T0 + 13 * MIN).features).toHaveLength(0);
		expect(replayPointsAt(buf, T0 + 11 * MIN).features).toHaveLength(1);
	});

	it("carries the replay-trail properties the layers style by", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ flight: "UA93", carrier: "UA", phase: "enroute" }),
			pos({ id: 2, flight: "UA93", carrier: "UA", start_date: iso(T0 + MIN) }),
		]);
		const f = replayPointsAt(buf, T0 + MIN / 2).features[0];
		expect(f.properties).toMatchObject({ flight: "UA93", notable: true });
	});
});

describe("pruneReplay", () => {
	it("drops samples older than the window edge and empties dead flights", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ id: 1, start_date: iso(T0) }),
			pos({ id: 2, start_date: iso(T0 + MIN) }),
			pos({ id: 3, flight: "UA930", start_date: iso(T0) }),
		]);
		pruneReplay(buf, T0 + MIN);
		expect(buf.get("DL100")!.samples).toHaveLength(1);
		expect(buf.has("UA930")).toBe(false);
	});
});

describe("replayPointsAt visibility", () => {
	it("skips flights not in the visible set; null or omitted keeps all", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ flight: "AA11", id: 1, start_date: "2001-09-11T13:00:00Z" }),
			pos({ flight: "UA175", id: 2, start_date: "2001-09-11T13:00:00Z" }),
		]);
		const t = Date.parse("2001-09-11T13:00:00Z");

		expect(replayPointsAt(buf, t).features).toHaveLength(2);
		expect(replayPointsAt(buf, t, null).features).toHaveLength(2);

		const only = replayPointsAt(buf, t, new Set(["AA11"]));
		expect(only.features).toHaveLength(1);
		expect(only.features[0].properties.flight).toBe("AA11");

		expect(replayPointsAt(buf, t, new Set()).features).toHaveLength(0);
	});
});

describe("replayTrails3DAt (3D replay-trail pucks)", () => {
	it("floats an extruded disc at the interpolated altitude", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ id: 1, alt_ft: 10_000, start_date: "2001-09-11T12:00:00Z" }),
			pos({ id: 2, alt_ft: 20_000, lon: -73.9, start_date: "2001-09-11T12:01:00Z" }),
		]);
		// Halfway between the samples → altitude interpolates to 15k ft.
		const fc = replayTrails3DAt(buf, T0 + MIN / 2, null, 0.5);
		expect(fc.features).toHaveLength(1);
		const f = fc.features[0];
		const altM = exaggeratedHeightM(15_000);
		expect(f.properties!.base).toBeCloseTo(altM - 500, 0); // radius 0.5 km
		expect(f.properties!.height).toBeCloseTo(altM + 500, 0);
		const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
		expect(ring).toHaveLength(9); // closed octagon
		expect(ring[0]).toEqual(ring[8]);
	});

	it("respects the visible set and skips grounded samples", () => {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ id: 1, flight: "AA11", start_date: "2001-09-11T12:00:00Z" }),
			pos({ id: 2, flight: "TAXI", alt_ft: 0, start_date: "2001-09-11T12:00:00Z" }),
		]);
		const fc = replayTrails3DAt(buf, T0, null, 0.5);
		expect(fc.features.map((f) => f.properties!.flight)).toEqual(["AA11"]);
		expect(replayTrails3DAt(buf, T0, new Set(), 0.5).features).toHaveLength(0);
	});
});

describe("buildReplayTrailInstances (3D replay-trail spheres)", () => {
	function twoSampleBuffer(): ReplayBuffer {
		const buf: ReplayBuffer = new Map();
		insertReplaySamples(buf, [
			pos({ id: 1, flight: "AA11", start_date: iso(T0), lat: 40, lon: -74, alt_ft: 20000 }),
			pos({ id: 2, flight: "AA11", start_date: iso(T0 + 2 * MIN), lat: 42, lon: -72, alt_ft: 24000 }),
			pos({ id: 3, flight: "TAXI", start_date: iso(T0), alt_ft: 0 }),
			pos({ id: 4, flight: "TAXI", start_date: iso(T0 + 2 * MIN), alt_ft: 0 }),
		]);
		return buf;
	}

	it("packs the interpolated fix into the shared instance layout; spheres don't rotate", () => {
		const inst = buildReplayTrailInstances(twoSampleBuffer(), T0 + MIN, null, 4);
		expect(inst.count).toBe(1); // grounded TAXI skipped
		expect(inst.flights).toEqual(["AA11"]);
		expect(inst.data).toHaveLength(PLANE_INSTANCE_STRIDE);
		const [mx, my, elev, mpm, heading, pitch, halfSize, notable] = inst.data;
		const [ex, ey] = lngLatToMercator(-73, 41); // linear midpoint of the two fixes
		expect(mx).toBeCloseTo(ex, 6);
		expect(my).toBeCloseTo(ey, 6);
		expect(elev).toBeCloseTo(exaggeratedHeightM(22000), 0);
		expect(mpm).toBeCloseTo(mercatorPerMeter(41), 12);
		expect(heading).toBe(0);
		expect(pitch).toBe(0);
		expect(halfSize).toBe(4000); // radiusKm 4 → sphere radius in meters
		expect(notable).toBe(1);
	});

	it("skips flights outside their lifetime and flights hidden by the filter", () => {
		const buf = twoSampleBuffer();
		expect(buildReplayTrailInstances(buf, T0 - MIN, null, 4).count).toBe(0);
		expect(buildReplayTrailInstances(buf, T0 + MIN, new Set(), 4).count).toBe(0);
		expect(buildReplayTrailInstances(buf, T0 + MIN, new Set(["AA11"]), 4).count).toBe(1);
	});
});
