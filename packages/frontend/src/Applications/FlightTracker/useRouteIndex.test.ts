import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import {
	ROUTE_INDEX_MAX_PAGES,
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

// Dispatches on the `flight_date` embedded in the URL rather than call order,
// since a single sample date now triggers fetches for both it and the
// previous UTC day (see flightDates.prevUtcDay) — call order alone can't
// pin a response to a specific date.
function dateFromUrl(url: string): string {
	return /flight_date%5D%5B_eq%5D=([0-9-]+)/.exec(String(url))![1];
}

function mockFetchByDate(byDate: Record<string, () => ApiRow[]>) {
	return vi.fn().mockImplementation((url: string) => {
		const date = dateFromUrl(url);
		const rows = byDate[date]?.() ?? [];
		return Promise.resolve({ ok: true, json: async () => ({ data: rows }) });
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

	it("sorts by id so offset pagination is deterministic", () => {
		// Postgres makes no ordering guarantee for LIMIT/OFFSET without ORDER BY,
		// so an unsorted page walk can repeat or skip rows between pages.
		expect(routeIndexUrl("2001-09-11", 1)).toContain("sort=id");
	});
});

describe("useRouteIndex", () => {
	afterEach(() => {
		cleanup();
		resetRouteIndexCache();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("fetches a sample date and its previous UTC day, and exposes rows keyed flight|date", async () => {
		// A single sample date now fetches TWO dates: the sample's own UTC date
		// and the day before it, since flight_date can land on either (see
		// flightDates.prevUtcDay).
		const fetchMock = mockFetchByDate({
			"2001-09-11": () => [apiRow("AA11", "2001-09-11")],
			"2001-09-10": () => [],
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result, rerender } = renderHook(
			({ positions }) => useRouteIndex(positions),
			{ initialProps: { positions: [pos("AA11", "2001-09-11T13:00:00Z")] } },
		);

		await waitFor(() =>
			expect(result.current.get("AA11|2001-09-11")).toEqual({
				tail_number: "N-AA11", origin: "BOS", scheduled_dest: "LAX",
				aircraft_type: null, wheels_on_utc: null,
			}),
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Same dates again → served from the module cache, no further fetches.
		rerender({ positions: [pos("UA175", "2001-09-11T14:00:00Z")] });
		await waitFor(() => expect(result.current.size).toBe(1));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("paginates until a short page", async () => {
		// Pin pagination to the 2001-09-11 sample date's URL: a full page then a
		// short page. The previous-day date (2001-09-10) that useRouteIndex now
		// also loads returns an empty single page.
		const fullPage = Array.from({ length: ROUTE_INDEX_PAGE_LIMIT }, (_, i) =>
			apiRow(`FL${i}`, "2001-09-11"),
		);
		const shortPage = [apiRow("LAST1", "2001-09-11")];
		let page11Calls = 0;
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const date = dateFromUrl(url);
			if (date === "2001-09-11") {
				page11Calls += 1;
				const data = page11Calls === 1 ? fullPage : shortPage;
				return Promise.resolve({ ok: true, json: async () => ({ data }) });
			}
			return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() =>
			useRouteIndex([pos("FL0", "2001-09-11T13:00:00Z")]),
		);

		await waitFor(() => expect(result.current.size).toBe(ROUTE_INDEX_PAGE_LIMIT + 1));
		const page11Urls = fetchMock.mock.calls
			.map((c) => String(c[0]))
			.filter((u) => dateFromUrl(u) === "2001-09-11");
		expect(page11Urls).toHaveLength(2);
		expect(page11Urls[0]).toContain("page=1");
		expect(page11Urls[1]).toContain("page=2");
	});

	it("fetches once per distinct date when positions span midnight, including each sample's previous UTC day", async () => {
		// Sample dates present: 09-11 and 09-12. Each also pulls in its previous
		// UTC day (09-10 and 09-11 respectively), so the distinct date set
		// fetched is {09-10, 09-11, 09-12} — three fetches, not two.
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const date = dateFromUrl(url);
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

		await waitFor(() => expect(result.current.size).toBe(3));
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const datesFetched = fetchMock.mock.calls.map((c) => dateFromUrl(String(c[0]))).sort();
		expect(datesFetched).toEqual(["2001-09-10", "2001-09-11", "2001-09-12"]);
		expect(result.current.get("F-2001-09-10|2001-09-10")).toBeTruthy();
		expect(result.current.get("F-2001-09-11|2001-09-11")).toBeTruthy();
		expect(result.current.get("F-2001-09-12|2001-09-12")).toBeTruthy();
	});

	it("stops immediately when the API repeats a page instead of paginating", async () => {
		// Reproduces the 2026-07-22 / 2026-07-24 production failure: an edge cache
		// that ignores the query string answers every `page=N` with page 1's body,
		// so `data.length` is always the full limit and the short-page break never
		// fires. The old loop spun to page 5883 against a 6-page date.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const page1 = Array.from({ length: ROUTE_INDEX_PAGE_LIMIT }, (_, i) =>
			apiRow(`FL${i}`, "2001-09-11"),
		);
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			const data = dateFromUrl(url) === "2001-09-11" ? page1 : [];
			return Promise.resolve({ ok: true, json: async () => ({ data }) });
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() =>
			useRouteIndex([pos("FL0", "2001-09-11T13:00:00Z")]),
		);

		await waitFor(() => expect(warn).toHaveBeenCalled());
		const pageUrls = fetchMock.mock.calls
			.map((c) => String(c[0]))
			.filter((u) => dateFromUrl(u) === "2001-09-11");
		// Detected on the second identical page — not thousands of requests later.
		expect(pageUrls).toHaveLength(2);
		// A partial index is never cached, so a later mount can retry cleanly.
		expect(result.current.size).toBe(0);
	});

	it("caps pages per date when the API never returns a short page", async () => {
		// Same runaway, but with each page's body distinct so the repeat detector
		// can't fire — the hard page ceiling is the backstop.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let served = 0;
		const fetchMock = vi.fn().mockImplementation((url: string) => {
			if (dateFromUrl(url) !== "2001-09-11") {
				return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
			}
			served += 1;
			const data = Array.from({ length: ROUTE_INDEX_PAGE_LIMIT }, (_, i) =>
				apiRow(`P${served}F${i}`, "2001-09-11"),
			);
			return Promise.resolve({ ok: true, json: async () => ({ data }) });
		});
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() => useRouteIndex([pos("P1F0", "2001-09-11T13:00:00Z")]));

		await waitFor(() => expect(warn).toHaveBeenCalled());
		expect(served).toBe(ROUTE_INDEX_MAX_PAGES);
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
