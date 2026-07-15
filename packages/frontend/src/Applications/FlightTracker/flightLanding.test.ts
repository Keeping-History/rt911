import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { RouteIndex } from "./flightFilter";
import { routeKey } from "./flightFilter";
import {
	LANDED_LINGER_MS,
	dropLandedPositions,
	landingClockOf,
	landingMsFor,
} from "./flightLanding";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "DL404", start_date: "2001-09-11T13:00:00Z",
	lat: 40, lon: -74, alt_ft: 30_000, ...over,
});

const row = (wheels_on_utc: string | null) => ({
	tail_number: null, origin: null, scheduled_dest: null,
	aircraft_type: null, wheels_on_utc,
});

const WHEELS_ON = "2001-09-11T13:05:00Z";
const WHEELS_ON_MS = Date.parse(WHEELS_ON);

function indexFor(flight: string, date: string, wheelsOn: string | null): RouteIndex {
	return new Map([[routeKey(flight, date), row(wheelsOn)]]);
}

describe("landingMsFor", () => {
	it("reads wheels_on_utc through the same flight-date join as routeRowFor", () => {
		const index = indexFor("DL404", "2001-09-11", WHEELS_ON);
		expect(landingMsFor(index, pos({}))).toBe(WHEELS_ON_MS);
	});

	it("falls back one UTC day for evening-departure flights", () => {
		// Samples dated 9/12 UTC, BTS local flight_date 9/11 (prevUtcDay quirk).
		const index = indexFor("DL404", "2001-09-11", WHEELS_ON);
		expect(
			landingMsFor(index, pos({ start_date: "2001-09-12T01:00:00Z" })),
		).toBe(WHEELS_ON_MS);
	});

	it("is null for unknown flights and null wheels_on_utc (crashes, open data)", () => {
		expect(landingMsFor(new Map(), pos({}))).toBeNull();
		const index = indexFor("DL404", "2001-09-11", null);
		expect(landingMsFor(index, pos({}))).toBeNull();
	});
});

describe("landingClockOf", () => {
	it("builds a per-flight landing map, letting overrides (notable crash times) win", () => {
		const index = indexFor("DL404", "2001-09-11", WHEELS_ON);
		const positions = [
			pos({}),
			pos({ id: 2, flight: "AA11" }), // no route row → only via override
		];
		const crash = Date.parse("2001-09-11T12:46:40Z");
		const landing = landingClockOf(positions, index, new Map([["AA11", crash]]));
		expect(landing.get("DL404")).toBe(WHEELS_ON_MS);
		expect(landing.get("AA11")).toBe(crash);
	});
});

describe("dropLandedPositions", () => {
	const index = indexFor("DL404", "2001-09-11", WHEELS_ON);

	it("keeps flights before and within the 2-minute linger, drops them after", () => {
		const positions = [pos({})];
		expect(dropLandedPositions(positions, index, WHEELS_ON_MS - 1)).toHaveLength(1);
		expect(
			dropLandedPositions(positions, index, WHEELS_ON_MS + LANDED_LINGER_MS - 1),
		).toHaveLength(1);
		expect(
			dropLandedPositions(positions, index, WHEELS_ON_MS + LANDED_LINGER_MS),
		).toHaveLength(0);
	});

	it("never drops the notable flights", () => {
		const crash = Date.parse("2001-09-11T12:46:40Z");
		const notableIndex = indexFor("AA11", "2001-09-11", "2001-09-11T12:46:40Z");
		const positions = [pos({ flight: "AA11" })];
		expect(
			dropLandedPositions(positions, notableIndex, crash + 10 * LANDED_LINGER_MS),
		).toHaveLength(1);
	});

	it("keeps flights with no landing time (unknown row / crash-null wheels_on)", () => {
		expect(
			dropLandedPositions([pos({ flight: "XX123" })], index, WHEELS_ON_MS * 2),
		).toHaveLength(1);
	});
});
