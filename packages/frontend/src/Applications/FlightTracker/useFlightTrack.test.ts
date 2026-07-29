import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FlightTrack, flightDateOf, pickLeg, trackUrl, useFlightTrack } from "./useFlightTrack";

describe("flightDateOf", () => {
	it("takes the UTC date component of an ISO start_date", () => {
		expect(flightDateOf("2001-09-11T12:46:40Z")).toBe("2001-09-11");
		expect(flightDateOf("2001-09-15T00:03:00.000Z")).toBe("2001-09-15");
	});
});

describe("trackUrl", () => {
	it("builds a filtered flight_tracks query against VITE_DIRECTUS_URL", () => {
		const url = trackUrl("AA11", "2001-09-11");
		expect(url).toContain("/items/flight_tracks?");
		expect(url).toContain("filter%5Bflight%5D%5B_eq%5D=AA11");
		expect(url).toContain("filter%5Bflight_date%5D%5B_eq%5D=2001-09-11");
		expect(url).toContain(
			"fields=flight%2Corigin%2Cscheduled_dest%2Clanded_at%2Cdiverted%2Cgeometry%2Ctail_number%2Caircraft_type%2Cdetails%2Cwheels_off_utc%2Cwheels_on_utc",
		);
		expect(url).toContain("limit=1");
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
