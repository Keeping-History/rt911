import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { profileUrl, useAltitudeProfile } from "./useAltitudeProfile";

const SAMPLES = [
	{ lat: 42.3656, lon: -71.0096, alt_ft: 0, utc: "2001-09-11T11:59:00.000Z" },
	{ lat: 42.37824, lon: -71.10853, alt_ft: 2364, utc: "2001-09-11T12:00:00.000Z" },
];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("profileUrl", () => {
	it("filters by flight and BTS flight_date, sorted by utc", () => {
		const url = new URL(profileUrl("AA11", "2001-09-11"));
		expect(url.pathname).toBe("/items/flight_positions");
		expect(url.searchParams.get("filter[flight][_eq]")).toBe("AA11");
		expect(url.searchParams.get("filter[flight_date][_eq]")).toBe("2001-09-11");
		expect(url.searchParams.get("fields")).toBe("lat,lon,alt_ft,utc,phase");
		expect(url.searchParams.get("sort")).toBe("utc");
	});

	it("requests the phase field for per-phase coloring", () => {
		const url = profileUrl("AA11", "2001-09-11");
		const fields = new URL(url).searchParams.get("fields");
		expect(fields).toContain("phase");
		expect(fields).toContain("lat");
		expect(fields).toContain("lon");
	});
});

describe("useAltitudeProfile", () => {
	it("fetches, caches, and returns the day's samples", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: SAMPLES }),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const sel = { flight: "AA11", startDate: "2001-09-11T12:00:00Z" };
		const { result, rerender } = renderHook(
			({ s }) => useAltitudeProfile(s),
			{ initialProps: { s: sel } },
		);
		await waitFor(() => expect(result.current.profile).toEqual(SAMPLES));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// New selection identity, same flight|date → effect reruns but the
		// cache serves it: no second network round-trip.
		rerender({ s: { ...sel } });
		await waitFor(() => expect(result.current.profile).toEqual(SAMPLES));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("falls back one UTC day when the local flight_date query is empty", async () => {
		const fetchMock = vi.fn(async (url: string) => ({
			ok: true,
			json: async () => ({
				data: String(url).includes("2001-09-12") ? [] : SAMPLES,
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);

		// Evening ET departure: samples dated 9/13 UTC, flight_date 9/12 local —
		// here the first (9/12) query returns empty and the fallback (9/11) hits.
		const { result } = renderHook(() =>
			useAltitudeProfile({ flight: "DL9", startDate: "2001-09-12T00:30:00Z" }),
		);
		await waitFor(() => expect(result.current.profile).toEqual(SAMPLES));
		expect(String(fetchMock.mock.calls[0][0])).toContain("2001-09-12");
		expect(String(fetchMock.mock.calls[1][0])).toContain("2001-09-11");
	});

	it("yields null on HTTP failure and for a cleared selection", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
		const { result, rerender } = renderHook(
			({ s }) => useAltitudeProfile(s),
			{ initialProps: { s: { flight: "AA11", startDate: "2001-09-11T12:00:00Z" } as { flight: string; startDate: string } | null } },
		);
		await waitFor(() => expect(result.current.profile).toBeNull());
		rerender({ s: null });
		expect(result.current.profile).toBeNull();
	});
});
