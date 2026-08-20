import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FlightTrack, pickLeg, trackUrl, useFlightTrack } from "./useFlightTrack";

describe("trackUrl", () => {
	it("builds a filtered flight_tracks query against VITE_DIRECTUS_URL", () => {
		const url = trackUrl("AA11", "2001-09-11");
		expect(url).toContain("/items/flight_tracks?");
		expect(url).toContain("filter%5Bflight%5D%5B_eq%5D=AA11");
		expect(url).toContain(
			"fields=flight%2Cflight_date%2Corigin%2Cscheduled_dest%2Clanded_at%2Cdiverted%2Cgeometry%2Ctail_number%2Caircraft_type%2Cdetails%2Cwheels_off_utc%2Cwheels_on_utc",
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
		flight: "WN6", flight_date: "2001-09-11", origin: "BWI", scheduled_dest: "MDW",
		landed_at: "MDW",
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

// AF1's two SHIPPED flight_tracks rows, verbatim from
// packages/tools/flight-recon/data/notable_flights/af1_0910.json and af1.json.
// Fabricated wheels times are what let the parked-morning bug through review —
// these values are the real ones and must stay in sync with those files.
describe("pickLeg across AF1's two shipped rows (real wheels + ground_stops)", () => {
	const af1_0910: FlightTrack = {
		flight: "AF1", flight_date: "2001-09-10", origin: "ADW", scheduled_dest: "SRQ",
		landed_at: "SRQ", diverted: false, geometry: null, tail_number: "SAM 28000",
		aircraft_type: "Boeing VC-25A",
		details: {
			ground_stops: [
				{ code: "NIP", name: "Naval Air Station Jacksonville",
					start: "2001-09-10T19:25:00Z", end: "2001-09-10T20:50:00Z" },
				{ code: "SRQ", name: "Sarasota-Bradenton International Airport",
					start: "2001-09-10T21:30:00Z", end: "2001-09-11T03:59:00Z" },
			],
		},
		wheels_off_utc: "2001-09-10T18:00:00Z", wheels_on_utc: "2001-09-10T21:30:00Z",
	};
	const af1_0911: FlightTrack = {
		flight: "AF1", flight_date: "2001-09-11", origin: "SRQ", scheduled_dest: "ADW",
		landed_at: "ADW", diverted: false, geometry: null, tail_number: "SAM 28000",
		aircraft_type: "Boeing VC-25A",
		details: {
			ground_stops: [
				{ code: "SRQ", name: "Sarasota-Bradenton International Airport",
					start: "2001-09-11T04:00:00Z", end: "2001-09-11T13:54:00Z" },
				{ code: "BAD", name: "Barksdale Air Force Base",
					start: "2001-09-11T15:45:00Z", end: "2001-09-11T17:44:00Z" },
				{ code: "OFF", name: "Offutt Air Force Base",
					start: "2001-09-11T18:50:00Z", end: "2001-09-11T20:33:00Z" },
			],
		},
		wheels_off_utc: "2001-09-11T13:54:00Z", wheels_on_utc: "2001-09-11T22:34:00Z",
	};
	// Both rows come back from the OR-across-two-days filter, in Directus order.
	const rows = [af1_0910, af1_0911];
	const at = (iso: string) => pickLeg(rows, Date.parse(iso));

	it("returns the 9/10 row while AF1 is still on its 9/10 legs and overnight at SRQ", () => {
		expect(at("2001-09-10T19:00:00Z")).toBe(af1_0910);   // aloft ADW→NIP
		expect(at("2001-09-10T23:00:00Z")).toBe(af1_0910);   // parked SRQ, 9/10 UTC
		expect(at("2001-09-11T02:00:00Z")).toBe(af1_0910);   // parked SRQ, 9/11 UTC
	});

	it("returns the 9/11 row through the parked Sarasota morning (the shipped bug)", () => {
		// 04:00Z is where the 9/11 file picks the aircraft up, still parked; the
		// wheels span alone doesn't start until 13:54Z, so these instants sit
		// outside BOTH rows' wheels spans and used to fall back to the 9/10 row.
		expect(at("2001-09-11T05:00:00Z")).toBe(af1_0911);
		expect(at("2001-09-11T10:00:00Z")).toBe(af1_0911);
		expect(at("2001-09-11T13:40:00Z")).toBe(af1_0911);
	});

	it("returns the 9/11 row for the airborne day and its Barksdale/Offutt stops", () => {
		expect(at("2001-09-11T14:30:00Z")).toBe(af1_0911);   // aloft SRQ→BAD
		expect(at("2001-09-11T16:30:00Z")).toBe(af1_0911);   // parked BAD
		expect(at("2001-09-11T19:30:00Z")).toBe(af1_0911);   // parked OFF
		expect(at("2001-09-11T22:00:00Z")).toBe(af1_0911);   // aloft OFF→ADW
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
		flight: "AF1", flight_date: "2001-09-10", origin: "SRQ", scheduled_dest: "ADW",
		landed_at: null,
		diverted: false, geometry: null, tail_number: null, aircraft_type: null,
		details: null, wheels_off_utc: "2001-09-10T22:00:00Z", wheels_on_utc: "2001-09-11T03:00:00Z",
	};
	const nextDayLeg: FlightTrack = {
		flight: "AF1", flight_date: "2001-09-11", origin: "SRQ", scheduled_dest: "BAD",
		landed_at: null,
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
