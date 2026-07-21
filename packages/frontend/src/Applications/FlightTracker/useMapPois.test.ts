import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapPoisUrl, resetMapPoisCache, useMapPois } from "./useMapPois";

const ROW = {
	id: 7, name: "Hartsfield", layer: "Major Airports", category: "airport",
	detail_title: "Airport Details", lat: 33.6, lon: -84.4,
	iata: "ATL", icao: "KATL", city: "Atlanta", region: "GA",
	details: { hub_class: "Large" },
};

afterEach(() => { cleanup(); resetMapPoisCache(); vi.restoreAllMocks(); });

describe("useMapPois", () => {
	it("builds a single anonymous limit=-1 query", () => {
		expect(mapPoisUrl()).toContain("/items/map_pois");
		expect(mapPoisUrl()).toContain("limit=-1");
	});

	it("loads and maps rows to MapPoi", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true, json: async () => ({ data: [ROW] }),
		} as Response);
		const { result } = renderHook(() => useMapPois());
		await waitFor(() => expect(result.current.length).toBe(1));
		expect(result.current[0]).toMatchObject({ id: 7, iata: "ATL", detailTitle: "Airport Details" });
	});

	it("degrades to [] on fetch failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 } as Response);
		const { result } = renderHook(() => useMapPois());
		await act(async () => { await Promise.resolve(); });
		expect(result.current).toEqual([]);
	});
});
