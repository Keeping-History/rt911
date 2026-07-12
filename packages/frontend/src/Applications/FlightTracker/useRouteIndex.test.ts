import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import {
	ROUTE_INDEX_PAGE_LIMIT,
	resetRouteIndexCache,
	routeIndexUrl,
	useRouteIndex,
} from "./useRouteIndex";

const pos = (flight: string, start_date: string): FlightPosition => ({
	id: 1, flight, start_date, lat: 40, lon: -74, alt_ft: 30000,
});

type ApiRow = {
	flight: string;
	flight_date: string;
	tail_number: string | null;
	origin: string | null;
	scheduled_dest: string | null;
};

const apiRow = (flight: string, flight_date: string): ApiRow => ({
	flight, flight_date, tail_number: `N-${flight}`, origin: "BOS", scheduled_dest: "LAX",
});

function mockFetchPages(...pages: ApiRow[][]) {
	let call = 0;
	return vi.fn().mockImplementation(() => {
		const data = pages[Math.min(call++, pages.length - 1)];
		return Promise.resolve({ ok: true, json: async () => ({ data }) });
	});
}

describe("routeIndexUrl", () => {
	it("queries flight_tracks by flight_date with only the small fields, paginated", () => {
		const url = routeIndexUrl("2001-09-11", 2);
		expect(url).toContain("/items/flight_tracks?");
		expect(url).toContain("filter%5Bflight_date%5D%5B_eq%5D=2001-09-11");
		expect(url).toContain(
			"fields=flight%2Cflight_date%2Ctail_number%2Corigin%2Cscheduled_dest",
		);
		expect(url).toContain(`limit=${ROUTE_INDEX_PAGE_LIMIT}`);
		expect(url).toContain("page=2");
	});
});

describe("useRouteIndex", () => {
	afterEach(() => {
		cleanup();
		resetRouteIndexCache();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("fetches each distinct flight date once and exposes rows keyed flight|date", async () => {
		const fetchMock = mockFetchPages([apiRow("AA11", "2001-09-11")]);
		vi.stubGlobal("fetch", fetchMock);

		const { result, rerender } = renderHook(
			({ positions }) => useRouteIndex(positions),
			{ initialProps: { positions: [pos("AA11", "2001-09-11T13:00:00Z")] } },
		);

		await waitFor(() =>
			expect(result.current.get("AA11|2001-09-11")).toEqual({
				tail_number: "N-AA11", origin: "BOS", scheduled_dest: "LAX",
			}),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Same date again → served from the module cache, no second fetch.
		rerender({ positions: [pos("UA175", "2001-09-11T14:00:00Z")] });
		await waitFor(() => expect(result.current.size).toBe(1));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("paginates until a short page", async () => {
		const fullPage = Array.from({ length: ROUTE_INDEX_PAGE_LIMIT }, (_, i) =>
			apiRow(`FL${i}`, "2001-09-11"),
		);
		const fetchMock = mockFetchPages(fullPage, [apiRow("LAST1", "2001-09-11")]);
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() =>
			useRouteIndex([pos("FL0", "2001-09-11T13:00:00Z")]),
		);

		await waitFor(() => expect(result.current.size).toBe(ROUTE_INDEX_PAGE_LIMIT + 1));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0][0])).toContain("page=1");
		expect(String(fetchMock.mock.calls[1][0])).toContain("page=2");
	});

	it("fetches once per distinct date when positions span midnight", async () => {
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const date = /flight_date%5D%5B_eq%5D=([0-9-]+)/.exec(String(url))![1];
			return Promise.resolve({
				ok: true,
				json: async () => ({ data: [apiRow(`F-${date}`, date)] }),
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() =>
			useRouteIndex([
				pos("AA1", "2001-09-11T23:50:00Z"),
				pos("UA2", "2001-09-12T00:10:00Z"),
			]),
		);

		await waitFor(() => expect(result.current.size).toBe(2));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.current.get("F-2001-09-11|2001-09-11")).toBeTruthy();
		expect(result.current.get("F-2001-09-12|2001-09-12")).toBeTruthy();
	});

	it("degrades gracefully on fetch failure: warns, stays empty, no throw", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

		const { result } = renderHook(() =>
			useRouteIndex([pos("AA11", "2001-09-11T13:00:00Z")]),
		);

		await waitFor(() => expect(warn).toHaveBeenCalled());
		expect(result.current.size).toBe(0);
	});
});
