import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlightTrack } from "./useFlightTrack";
import { useMultiFlightTracks } from "./useMultiFlightTracks";

const GEOMETRY = { type: "LineString" as const, coordinates: [[-73, 40], [-72, 41]] as [number, number][] };
const SAMPLES = [
	{ lat: 40, lon: -73, alt_ft: 0, utc: "2001-09-11T12:00:00.000Z" },
	{ lat: 41, lon: -72, alt_ft: 5000, utc: "2001-09-11T12:05:00.000Z" },
];

function trackRow(flight: string): FlightTrack {
	return {
		flight, flight_date: "2001-09-11", origin: null, scheduled_dest: null, landed_at: null,
		diverted: false, geometry: GEOMETRY, tail_number: null, aircraft_type: null,
		details: null, wheels_off_utc: null, wheels_on_utc: null,
	};
}

/** Routes by URL: flight_tracks -> the given rows, flight_positions -> SAMPLES. */
function stubFetch(rowsFor: (flight: string) => FlightTrack[]) {
	const fetchMock = vi.fn(async (url: string) => {
		const u = String(url);
		if (u.includes("/items/flight_tracks")) {
			const flight = new URL(u).searchParams.get("filter[flight][_eq]") ?? "";
			return { ok: true, json: async () => ({ data: rowsFor(flight) }) } as Response;
		}
		return { ok: true, json: async () => ({ data: SAMPLES }) } as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("useMultiFlightTracks", () => {
	it("returns an empty map for no selections without fetching", () => {
		const fetchMock = stubFetch((f) => [trackRow(f)]);
		const { result } = renderHook(
			({ s }) => useMultiFlightTracks(s),
			{ initialProps: { s: [] as { flight: string; startDate: string }[] } },
		);
		expect(result.current.size).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fetches geometry and profile for every selection, keyed by flight", async () => {
		stubFetch((f) => [trackRow(f)]);
		const { result } = renderHook(
			({ s }) => useMultiFlightTracks(s),
			{
				initialProps: {
					s: [
						{ flight: "UA175", startDate: "2001-09-11T12:03:00Z" },
						{ flight: "AA77", startDate: "2001-09-11T12:03:00Z" },
					],
				},
			},
		);

		await waitFor(() => expect(result.current.size).toBe(2));
		expect(result.current.get("UA175")).toEqual({
			flight: "UA175", geometry: GEOMETRY, profile: SAMPLES,
		});
		expect(result.current.get("AA77")).toEqual({
			flight: "AA77", geometry: GEOMETRY, profile: SAMPLES,
		});
	});

	it("caches by flight|date|hour across renders — a referentially-equal selection list doesn't refetch", async () => {
		const fetchMock = stubFetch((f) => [trackRow(f)]);
		const selections = [{ flight: "UA175", startDate: "2001-09-11T12:03:00Z" }];
		const { result, rerender } = renderHook(
			({ s }) => useMultiFlightTracks(s),
			{ initialProps: { s: selections } },
		);
		await waitFor(() => expect(result.current.size).toBe(1));
		expect(fetchMock).toHaveBeenCalledTimes(2); // one track + one profile fetch

		// A NEW array with an equivalent (same flight|date|hour) selection still
		// hits the hook's own cache, not the network.
		rerender({ s: [{ flight: "UA175", startDate: "2001-09-11T12:03:30Z" }] });
		await waitFor(() => expect(result.current.size).toBe(1));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("skips a flight whose track fetch fails, without throwing or dropping the rest", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchMock = vi.fn(async (url: string) => {
			const u = String(url);
			if (u.includes("/items/flight_tracks")) {
				if (u.includes("_eq%5D=BAD1")) return { ok: false, status: 500 } as Response;
				return { ok: true, json: async () => ({ data: [trackRow("UA175")] }) } as Response;
			}
			return { ok: true, json: async () => ({ data: SAMPLES }) } as Response;
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(
			({ s }) => useMultiFlightTracks(s),
			{
				initialProps: {
					s: [
						{ flight: "BAD1", startDate: "2001-09-11T12:00:00Z" },
						{ flight: "UA175", startDate: "2001-09-11T12:03:00Z" },
					],
				},
			},
		);

		await waitFor(() => expect(result.current.size).toBe(1));
		expect(result.current.has("BAD1")).toBe(false);
		expect(result.current.get("UA175")?.geometry).toEqual(GEOMETRY);
	});

	it("clears the map when selections become empty", async () => {
		stubFetch((f) => [trackRow(f)]);
		const { result, rerender } = renderHook(
			({ s }) => useMultiFlightTracks(s),
			{ initialProps: { s: [{ flight: "UA175", startDate: "2001-09-11T12:03:00Z" }] } },
		);
		await waitFor(() => expect(result.current.size).toBe(1));
		rerender({ s: [] });
		expect(result.current.size).toBe(0);
	});
});
