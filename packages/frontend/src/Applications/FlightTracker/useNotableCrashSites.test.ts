import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTABLE_FLIGHTS } from "./notableFlights";
import {
	crashSiteUrl,
	resetNotableCrashCache,
	useNotableCrashSites,
} from "./useNotableCrashSites";

// Final two samples, newest first — the shape the sort=-utc fetch returns.
const AA11_DESC = [
	{ id: 902, lat: 40.71236, lon: -74.01303, alt_ft: 1360, utc: "2001-09-11T12:46:40.000Z", phase: "descent" },
	{ id: 901, lat: 40.89127, lon: -74.0023, alt_ft: 6126, utc: "2001-09-11T12:45:00.000Z", phase: "descent" },
];

beforeEach(() => resetNotableCrashCache());
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("crashSiteUrl", () => {
	it("asks for the flight's two newest 9/11 samples", () => {
		const url = new URL(crashSiteUrl("AA11"));
		expect(url.pathname).toBe("/items/flight_positions");
		expect(url.searchParams.get("filter[flight][_eq]")).toBe("AA11");
		expect(url.searchParams.get("filter[flight_date][_eq]")).toBe("2001-09-11");
		expect(url.searchParams.get("sort")).toBe("-utc");
		expect(url.searchParams.get("limit")).toBe("2");
	});
});

describe("useNotableCrashSites", () => {
	it("returns each notable's final samples (time-ascending) and crash instant", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: AA11_DESC }),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useNotableCrashSites());
		await waitFor(() =>
			expect(result.current.crashMs.get("AA11")).toBe(
				Date.parse("2001-09-11T12:46:40.000Z"),
			),
		);
		// One fetch per notable, results cached module-wide.
		expect(fetchMock).toHaveBeenCalledTimes(NOTABLE_FLIGHTS.length);

		const aa11 = result.current.samples.filter((s) => s.flight === "AA11");
		expect(aa11.map((s) => s.start_date)).toEqual([
			"2001-09-11T12:45:00.000Z",
			"2001-09-11T12:46:40.000Z", // ascending: penultimate then impact
		]);
		expect(aa11[1].lat).toBeCloseTo(40.71236, 6);
		expect(aa11[1].carrier).toBe("AA");

		const { result: second } = renderHook(() => useNotableCrashSites());
		await waitFor(() => expect(second.current.crashMs.size).toBeGreaterThan(0));
		expect(fetchMock).toHaveBeenCalledTimes(NOTABLE_FLIGHTS.length);
	});

	it("degrades gracefully: failed fetches leave that notable absent", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
		const { result } = renderHook(() => useNotableCrashSites());
		// Nothing arrives; the hook settles to an empty result without throwing.
		await new Promise((r) => setTimeout(r, 10));
		expect(result.current.samples).toHaveLength(0);
		expect(result.current.crashMs.size).toBe(0);
	});
});
