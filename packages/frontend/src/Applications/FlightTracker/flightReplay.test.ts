import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import {
	insertReplaySamples,
	pruneReplay,
	type ReplayBuffer,
	replayPointsAt,
} from "./flightReplay";

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

	it("carries the ghost properties the layers style by", () => {
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
