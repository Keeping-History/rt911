import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import {
	EMPTY_FLIGHT_FILTER,
	type FlightFilter,
	type RouteIndex,
	type RouteIndexRow,
	isFilterActive,
	matchesFilter,
	popUpOptions,
	prevUtcDay,
	routeKey,
	routeRowFor,
	visibleFlightSet,
} from "./flightFilter";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1,
	flight: "AA11",
	start_date: "2001-09-11T13:00:00Z",
	lat: 40,
	lon: -74,
	alt_ft: 30000,
	...over,
});

const row = (over: Partial<RouteIndexRow>): RouteIndexRow => ({
	tail_number: null,
	origin: null,
	scheduled_dest: null,
	...over,
});

const filter = (over: Partial<FlightFilter>): FlightFilter => ({
	...EMPTY_FLIGHT_FILTER,
	...over,
});

describe("routeKey", () => {
	it("joins flight and date with a pipe", () => {
		expect(routeKey("AA11", "2001-09-11")).toBe("AA11|2001-09-11");
	});
});

describe("prevUtcDay", () => {
	it("steps back one UTC day", () => {
		expect(prevUtcDay("2001-09-13")).toBe("2001-09-12");
	});

	it("crosses a month boundary", () => {
		expect(prevUtcDay("2001-10-01")).toBe("2001-09-30");
	});
});

describe("routeRowFor", () => {
	it("finds the row by the sample's own UTC date when present (primary date wins)", () => {
		const primary = row({ tail_number: "N334AA", origin: "IAD", scheduled_dest: "LAX" });
		const fallback = row({ tail_number: "N999ZZ", origin: "BOS", scheduled_dest: "ORD" });
		const index: RouteIndex = new Map([
			["AA99|2001-09-13", primary],
			["AA99|2001-09-12", fallback],
		]);
		const p = pos({ flight: "AA99", start_date: "2001-09-13T00:30:00Z" });
		expect(routeRowFor(index, p)).toBe(primary);
	});

	it("falls back to the previous UTC day for an evening-departure flight whose flight_date is local", () => {
		// Departed ~8:30 PM ET on 9/12 (flight_date = 2001-09-12, BTS local
		// date), but the sample is dated after UTC midnight.
		const row1 = row({ tail_number: "N999ZZ", origin: "BOS", scheduled_dest: "ORD" });
		const index: RouteIndex = new Map([["AA99|2001-09-12", row1]]);
		const p = pos({ flight: "AA99", start_date: "2001-09-13T00:30:00Z" });
		expect(routeRowFor(index, p)).toBe(row1);
	});

	it("returns undefined when neither date has a row", () => {
		const index: RouteIndex = new Map();
		const p = pos({ flight: "AA99", start_date: "2001-09-13T00:30:00Z" });
		expect(routeRowFor(index, p)).toBeUndefined();
	});
});

describe("isFilterActive", () => {
	it("is false for the empty filter and true when any field is set", () => {
		expect(isFilterActive(EMPTY_FLIGHT_FILTER)).toBe(false);
		expect(isFilterActive(filter({ flight: "AA11" }))).toBe(true);
		expect(isFilterActive(filter({ tail: "N334AA" }))).toBe(true);
		expect(isFilterActive(filter({ carrier: "AA" }))).toBe(true);
		expect(isFilterActive(filter({ origin: "BOS" }))).toBe(true);
		expect(isFilterActive(filter({ dest: "LAX" }))).toBe(true);
	});
});

describe("matchesFilter", () => {
	it("matches everything when the filter is empty", () => {
		expect(matchesFilter(pos({}), undefined, EMPTY_FLIGHT_FILTER)).toBe(true);
	});

	it("matches flight # exactly against the streamed position", () => {
		expect(matchesFilter(pos({ flight: "AA11" }), undefined, filter({ flight: "AA11" }))).toBe(true);
		expect(matchesFilter(pos({ flight: "AA110" }), undefined, filter({ flight: "AA11" }))).toBe(false);
	});

	it("matches carrier against the streamed position only (flight_tracks has no carrier)", () => {
		expect(matchesFilter(pos({ carrier: "AA" }), undefined, filter({ carrier: "AA" }))).toBe(true);
		expect(matchesFilter(pos({ carrier: "UA" }), undefined, filter({ carrier: "AA" }))).toBe(false);
		// Missing metadata fails the criterion.
		expect(matchesFilter(pos({ carrier: undefined }), undefined, filter({ carrier: "AA" }))).toBe(false);
	});

	it("matches tail/origin/dest against the route index row", () => {
		const r = row({ tail_number: "N334AA", origin: "BOS", scheduled_dest: "LAX" });
		expect(matchesFilter(pos({}), r, filter({ tail: "N334AA" }))).toBe(true);
		expect(matchesFilter(pos({}), r, filter({ tail: "N612UA" }))).toBe(false);
		expect(matchesFilter(pos({}), r, filter({ origin: "BOS" }))).toBe(true);
		expect(matchesFilter(pos({}), r, filter({ origin: "IAD" }))).toBe(false);
		expect(matchesFilter(pos({}), r, filter({ dest: "LAX" }))).toBe(true);
		expect(matchesFilter(pos({}), r, filter({ dest: "SFO" }))).toBe(false);
	});

	it("fails index-backed criteria when the flight has no index row", () => {
		expect(matchesFilter(pos({}), undefined, filter({ tail: "N334AA" }))).toBe(false);
		expect(matchesFilter(pos({}), undefined, filter({ origin: "BOS" }))).toBe(false);
		expect(matchesFilter(pos({}), undefined, filter({ dest: "LAX" }))).toBe(false);
	});

	it("ANDs criteria together", () => {
		const r = row({ origin: "BOS", scheduled_dest: "LAX" });
		expect(matchesFilter(pos({ carrier: "AA" }), r, filter({ carrier: "AA", origin: "BOS" }))).toBe(true);
		expect(matchesFilter(pos({ carrier: "AA" }), r, filter({ carrier: "AA", origin: "IAD" }))).toBe(false);
	});
});

describe("visibleFlightSet", () => {
	const index: RouteIndex = new Map([
		["AA11|2001-09-11", row({ tail_number: "N334AA", origin: "BOS", scheduled_dest: "LAX" })],
		["UA175|2001-09-11", row({ tail_number: "N612UA", origin: "BOS", scheduled_dest: "LAX" })],
	]);
	const positions = [
		pos({ flight: "AA11", carrier: "AA" }),
		pos({ flight: "UA175", carrier: "UA" }),
		pos({ flight: "DL1989", carrier: "DL" }), // no index row
	];

	it("returns null (show everything) when the filter is inactive", () => {
		expect(visibleFlightSet(positions, index, EMPTY_FLIGHT_FILTER)).toBeNull();
	});

	it("returns the set of matching flights, joining positions to index rows by flight|date", () => {
		expect(visibleFlightSet(positions, index, filter({ origin: "BOS" }))).toEqual(
			new Set(["AA11", "UA175"]),
		);
		expect(visibleFlightSet(positions, index, filter({ carrier: "AA" }))).toEqual(
			new Set(["AA11"]),
		);
		expect(visibleFlightSet(positions, index, filter({ origin: "BOS", carrier: "UA" }))).toEqual(
			new Set(["UA175"]),
		);
	});

	it("returns an empty set when nothing matches", () => {
		expect(visibleFlightSet(positions, index, filter({ origin: "JFK" }))).toEqual(new Set());
	});

	it("joins an evening-departure flight across the local/UTC flight_date boundary", () => {
		// AA99's flight_date (BTS local departure date) is 2001-09-12, but it
		// departed late enough that its samples are dated 2001-09-13 UTC.
		const eveningIndex: RouteIndex = new Map([
			["AA99|2001-09-12", row({ tail_number: "N999ZZ", origin: "BOS", scheduled_dest: "ORD" })],
		]);
		const eveningPositions = [pos({ flight: "AA99", start_date: "2001-09-13T00:30:00Z" })];
		expect(
			visibleFlightSet(eveningPositions, eveningIndex, filter({ origin: "BOS" })),
		).toEqual(new Set(["AA99"]));
	});
});

describe("popUpOptions", () => {
	it("dedupes, sorts, drops empties, and puts Any first", () => {
		expect(popUpOptions(["UA", "AA", "AA", "", null, undefined], "")).toEqual([
			{ value: "", label: "Any" },
			{ value: "AA", label: "AA" },
			{ value: "UA", label: "UA" },
		]);
	});

	it("synthesizes the current selection when it is absent so a stale filter never self-clears", () => {
		expect(popUpOptions(["AA"], "UA")).toEqual([
			{ value: "", label: "Any" },
			{ value: "AA", label: "AA" },
			{ value: "UA", label: "UA" },
		]);
	});
});
