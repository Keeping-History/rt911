import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FlightTrack, pickLeg, trackUrl, useFlightTrack } from "./useFlightTrack";

describe("trackUrl", () => {
	it("builds a filtered flight_tracks query against VITE_DIRECTUS_URL", () => {
		const url = trackUrl("AA11", "2001-09-11");
		expect(url).toContain("/items/flight_tracks?");
		expect(url).toContain("filter%5Bflight%5D%5B_eq%5D=AA11");
		expect(url).toContain(
			"fields=flight%2Corigin%2Cscheduled_dest%2Clanded_at%2Cdiverted%2Cgeometry%2Ctail_number%2Caircraft_type%2Cdetails%2Cwheels_off_utc%2Cwheels_on_utc",
		);
		expect(url).toContain("limit=1");
	});

	it("ORs flight_date across both the sample's UTC day and the day before (flightDates' prevUtcDay boundary)", () => {
		const url = trackUrl("AF1", "2001-09-11");
		expect(url).toContain("filter%5B_or%5D%5B0%5D%5Bflight_date%5D%5B_eq%5D=2001-09-11");
		expect(url).toContain("filter%5B_or%5D%5B1%5D%5Bflight_date%5D%5B_eq%5D=2001-09-10");
	});
});

describe("useFlightTrack error handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("surfaces a friendly 'Track unavailable', not a raw HTTP status, on a non-ok response", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response),
		);

		const { result } = renderHook(() =>
			useFlightTrack({ flight: "AA77", startDate: "2001-09-11T13:00:00Z" }),
		);

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.track).toBeNull();
		expect(result.current.error).toBe("Track unavailable");
		expect(result.current.error).not.toContain("403");
	});
});

describe("pickLeg (multi-leg flight numbers)", () => {
	const leg = (off: string, on: string): FlightTrack => ({
		flight: "WN6", origin: "BWI", scheduled_dest: "MDW", landed_at: "MDW",
		diverted: false, geometry: null, tail_number: null, aircraft_type: null,
		details: null, wheels_off_utc: off, wheels_on_utc: on,
	});
	const morning = leg("2001-09-11T11:00:00Z", "2001-09-11T13:00:00Z");
	const noon = leg("2001-09-11T15:30:00Z", "2001-09-11T17:00:00Z");

	it("returns the sole row untouched", () => {
		expect(pickLeg([morning], Date.parse("2001-09-11T20:00:00Z"))).toBe(morning);
		expect(pickLeg([], 0)).toBeNull();
	});

	it("picks the leg whose wheels span contains the selection instant", () => {
		expect(pickLeg([noon, morning], Date.parse("2001-09-11T12:00:00Z"))).toBe(morning);
		expect(pickLeg([noon, morning], Date.parse("2001-09-11T16:00:00Z"))).toBe(noon);
	});

	it("allows slack around the span (taxi / lingering pin)", () => {
		expect(pickLeg([noon, morning], Date.parse("2001-09-11T10:55:00Z"))).toBe(morning);
		expect(pickLeg([noon, morning], Date.parse("2001-09-11T17:05:00Z"))).toBe(noon);
	});

	it("falls back to the earliest leg when nothing matches", () => {
		expect(pickLeg([noon, morning], Date.parse("2001-09-11T23:00:00Z"))).toBe(morning);
	});
});

describe("useFlightTrack across the flight_date UTC boundary (AF1 overnight ground stop)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// AF1's overnight SRQ stop is filed under flight_date=2001-09-10 even
	// though it covers early-UTC instants on 9/11. Before the OR-filter fix,
	// clicking AF1 at 02:00Z on 9/11 fetched only the 9/11-dated leg (a
	// single row short-circuits pickLeg) and showed the wrong leg entirely.
	const overnightLeg: FlightTrack = {
		flight: "AF1", origin: "SRQ", scheduled_dest: "ADW", landed_at: null,
		diverted: false, geometry: null, tail_number: null, aircraft_type: null,
		details: null, wheels_off_utc: "2001-09-10T22:00:00Z", wheels_on_utc: "2001-09-11T03:00:00Z",
	};
	const nextDayLeg: FlightTrack = {
		flight: "AF1", origin: "SRQ", scheduled_dest: "BAD", landed_at: null,
		diverted: false, geometry: null, tail_number: null, aircraft_type: null,
		details: null, wheels_off_utc: "2001-09-11T13:54:00Z", wheels_on_utc: "2001-09-11T15:45:00Z",
	};

	it("fetches with a filter matching both 2001-09-11 and 2001-09-10, and pickLeg selects the 09-10 leg for that instant", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: [nextDayLeg, overnightLeg] }),
		} as Response);
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() =>
			useFlightTrack({ flight: "AF1", startDate: "2001-09-11T02:00:00Z" }),
		);

		await waitFor(() => expect(result.current.loading).toBe(false));

		const requestedUrl = fetchMock.mock.calls[0]?.[0] as string;
		expect(requestedUrl).toContain("filter%5B_or%5D%5B0%5D%5Bflight_date%5D%5B_eq%5D=2001-09-11");
		expect(requestedUrl).toContain("filter%5B_or%5D%5B1%5D%5Bflight_date%5D%5B_eq%5D=2001-09-10");
		expect(result.current.track).toBe(overnightLeg);
	});
});
