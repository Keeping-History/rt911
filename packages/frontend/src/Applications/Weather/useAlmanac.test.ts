import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlmanacFile } from "./useAlmanac";
import { almanacUrl, useAlmanac } from "./useAlmanac";

const FAKE_ALMANAC: AlmanacFile = {
	station_id: "KJFK",
	ghcn_id: "USW00094789",
	cutoff: "2001-09-08",
	run_id: "abc123",
	days: {
		"09-09": {
			record_high_c: 30, record_high_year: 1983,
			record_low_c: 12, record_low_year: 1965,
			normal_high_c: 25.1, normal_low_c: 17.8,
			record_precip_mm: 40, record_precip_year: 1960,
		},
		"09-10": {
			record_high_c: null, record_high_year: null,
			record_low_c: null, record_low_year: null,
			normal_high_c: null, normal_low_c: null,
			record_precip_mm: null, record_precip_year: null,
		},
		"09-11": {
			record_high_c: 31, record_high_year: 1955,
			record_low_c: 11, record_low_year: 1990,
			normal_high_c: 24.7, normal_low_c: 17.3,
			record_precip_mm: 38, record_precip_year: 1961,
		},
		"09-12": {
			record_high_c: 29, record_high_year: 1998,
			record_low_c: 10, record_low_year: 2000,
			normal_high_c: 24.3, normal_low_c: 16.9,
			record_precip_mm: 35, record_precip_year: 1979,
		},
	},
};

describe("almanacUrl", () => {
	it("builds the static Wasabi path for a station id", () => {
		expect(almanacUrl("KJFK")).toBe(
			"https://files.911realtime.org/weather/almanac/KJFK.json",
		);
	});
});

describe("useAlmanac", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("returns null/not-loading when stationId is null", () => {
		const { result } = renderHook(() => useAlmanac(null));
		expect(result.current.almanac).toBeNull();
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it("fetches and returns the almanac for a station", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => FAKE_ALMANAC,
		} as Response);
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useAlmanac("KJFK"));
		expect(result.current.loading).toBe(true);

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.almanac).toEqual(FAKE_ALMANAC);
		expect(result.current.error).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://files.911realtime.org/weather/almanac/KJFK.json",
			expect.objectContaining({ signal: expect.anything() }),
		);
	});

	it("caches per station id — a re-render with the same station does not re-fetch", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => FAKE_ALMANAC,
		} as Response);
		vi.stubGlobal("fetch", fetchMock);

		const { result, rerender } = renderHook(
			({ stationId }: { stationId: string | null }) => useAlmanac(stationId),
			{ initialProps: { stationId: "KJFK" } },
		);
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		rerender({ stationId: "KJFK" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.current.almanac).toEqual(FAKE_ALMANAC);
	});

	it("re-fetches when the station id changes", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => FAKE_ALMANAC,
		} as Response);
		vi.stubGlobal("fetch", fetchMock);

		const { result, rerender } = renderHook(
			({ stationId }: { stationId: string | null }) => useAlmanac(stationId),
			{ initialProps: { stationId: "KJFK" } },
		);
		await waitFor(() => expect(result.current.loading).toBe(false));

		rerender({ stationId: "KORD" });
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(fetchMock).toHaveBeenLastCalledWith(
			"https://files.911realtime.org/weather/almanac/KORD.json",
			expect.objectContaining({ signal: expect.anything() }),
		);
	});

	it("surfaces a friendly error, never throws, on a non-ok response", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response),
		);

		const { result } = renderHook(() => useAlmanac("ZZZZ"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.almanac).toBeNull();
		expect(result.current.error).toBe("Almanac unavailable");
		expect(result.current.error).not.toContain("404");
	});

	it("surfaces a friendly error, never throws, on a network failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

		const { result } = renderHook(() => useAlmanac("ZZZZ"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.almanac).toBeNull();
		expect(result.current.error).toBe("Almanac unavailable");
	});

	it("clears the almanac when the station reverts to null", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => FAKE_ALMANAC,
		} as Response);
		vi.stubGlobal("fetch", fetchMock);

		const { result, rerender } = renderHook(
			({ stationId }: { stationId: string | null }) => useAlmanac(stationId),
			{ initialProps: { stationId: "KJFK" as string | null } },
		);
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.almanac).toEqual(FAKE_ALMANAC);

		rerender({ stationId: null });
		expect(result.current.almanac).toBeNull();
		expect(result.current.loading).toBe(false);
	});
});
