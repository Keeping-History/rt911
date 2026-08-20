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
		expect(url.searchParams.get("fields")).toBe("lat,lon,alt_ft,utc,phase,source");
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

	// AF1 has flight_positions on BOTH 9/10 and 9/11, so "did the primary day
	// return zero rows?" can never distinguish them: a 9/10-evening instant whose
	// UTC date is already 9/11 hits the 9/11 day and gets the WRONG day's profile
	// — which FlightTracker also draws AF1's track from. The selected track's own
	// flight_date is the only authority.
	describe("two-day flights (AF1)", () => {
		const day = (d: string) => [
			{ lat: 27.3954, lon: -82.5544, alt_ft: 30, utc: `${d}T02:00:00.000Z` },
			{ lat: 27.3954, lon: -82.5544, alt_ft: 30, utc: `${d}T02:01:00.000Z` },
		];
		const twoDayFetch = () =>
			vi.fn(async (url: string) => ({
				ok: true,
				json: async () => ({
					data: String(url).includes("2001-09-10") ? day("2001-09-10") : day("2001-09-11"),
				}),
			}));

		it("keys the profile off the selected track's flight_date, not the sample's UTC day", async () => {
			const fetchMock = twoDayFetch();
			vi.stubGlobal("fetch", fetchMock);

			// 02:00Z on 9/11 is still the 9/10-dated overnight leg.
			const { result } = renderHook(() =>
				useAltitudeProfile({ flight: "AF1", startDate: "2001-09-11T02:00:00Z" }, "2001-09-10"),
			);
			await waitFor(() => expect(result.current.profile).not.toBeNull());
			expect(String(fetchMock.mock.calls[0][0])).toContain("2001-09-10");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.current.profile?.every((p) => p.utc.startsWith("2001-09-10"))).toBe(true);
		});

		it("caches per track flight_date, so the same instant on the other row refetches", async () => {
			const fetchMock = twoDayFetch();
			vi.stubGlobal("fetch", fetchMock);

			const { result, rerender } = renderHook(
				({ d }) => useAltitudeProfile({ flight: "AF1", startDate: "2001-09-11T02:00:00Z" }, d),
				{ initialProps: { d: "2001-09-10" } },
			);
			await waitFor(() =>
				expect(result.current.profile?.[0].utc.startsWith("2001-09-10")).toBe(true),
			);
			rerender({ d: "2001-09-11" });
			await waitFor(() =>
				expect(result.current.profile?.[0].utc.startsWith("2001-09-11")).toBe(true),
			);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
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
