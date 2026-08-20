import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { overlappingSpans, usePeaksForSpan } from "./usePeaksForSpan";

function jsonResponse(data: unknown, ok = true): Response {
	return { ok, json: async () => data } as Response;
}

const WINDOW_START = Date.UTC(2001, 8, 11, 12, 0);
const WINDOW_END = Date.UTC(2001, 8, 11, 12, 30);

describe("usePeaksForSpan", () => {
	it("returns recordings that have peaks, positioned by their own start/duration", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				data: [
					{ id: 901, start_date: "2001-09-11T12:00:00", calc_duration: 30, peaks: [[-10, 10]] },
					// no peaks yet (compute-peaks hasn't reached this row) — dropped
					{ id: 902, start_date: "2001-09-11T12:01:00", calc_duration: 20, peaks: [] },
				],
			}),
		);

		const { result } = renderHook(() =>
			usePeaksForSpan("WCBS", WINDOW_START, WINDOW_END, fetchFn as unknown as typeof fetch),
		);

		await waitFor(() => expect(result.current).toHaveLength(1));
		expect(result.current[0]).toEqual({
			id: 901,
			startMs: WINDOW_START,
			endMs: WINDOW_START + 30_000,
			peaks: [[-10, 10]],
		});
		// The row id is what keys the rendered slot, so the query has to ask for
		// it — without the projection every span would arrive id-less.
		expect(decodeURIComponent(String((fetchFn.mock.calls[0] as unknown[])[0]))).toContain(
			"fields=id,start_date,calc_duration,peaks",
		);
	});

	it("includes a recording that started before the window and runs into it", async () => {
		// 30 minutes of WCBS starting at 11:50 — its START is outside a
		// 12:00–12:30 window, so a `start_date BETWEEN` predicate alone drops it
		// and the preview comes up blank exactly when you have zoomed in far
		// enough to care.
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				data: [
					{ id: 903, start_date: "2001-09-11T11:50:00", calc_duration: 1800, peaks: [[-3, 3]] },
					// Ends five minutes before the window opens: no overlap, dropped.
					{ id: 904, start_date: "2001-09-11T11:50:00", calc_duration: 300, peaks: [[-9, 9]] },
				],
			}),
		);

		const { result } = renderHook(() =>
			usePeaksForSpan("WCBS", WINDOW_START, WINDOW_END, fetchFn as unknown as typeof fetch),
		);

		await waitFor(() => expect(result.current).toHaveLength(1));
		expect(result.current[0].startMs).toBe(Date.UTC(2001, 8, 11, 11, 50));

		// The server-side half of the predicate has to reach back far enough for
		// that row to be returned at all: `end_date` is not readable anonymously,
		// so the overlap is completed client-side over a lookback window.
		const query = decodeURIComponent(String((fetchFn.mock.calls[0] as unknown[])[0]));
		const between = /filter\[start_date\]\[_between\]=([^&]+)/.exec(query)?.[1];
		expect(between).toBeDefined();
		const [lowerBound, upperBound] = between!.split(",");
		expect(Date.parse(lowerBound)).toBeLessThanOrEqual(Date.UTC(2001, 8, 11, 11, 50));
		expect(Date.parse(upperBound)).toBe(WINDOW_END);
	});

	it("filters by the station's source slug", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ data: [] }));
		renderHook(() =>
			usePeaksForSpan("NEADS/NORAD", WINDOW_START, WINDOW_END, fetchFn as unknown as typeof fetch),
		);
		await waitFor(() => expect(fetchFn).toHaveBeenCalled());
		const url = String((fetchFn.mock.calls[0] as unknown[])[0]);
		expect(url).toContain("/items/mp3_items?");
		// The slash in the slug must be escaped, not concatenated into the query.
		expect(url).toContain("NEADS%2FNORAD");
		expect(decodeURIComponent(url)).toContain("filter[source][slug][_eq]=NEADS/NORAD");
	});

	it("stays quiet (empty) on a failed fetch", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({}, false));
		const { result } = renderHook(() =>
			usePeaksForSpan("WCBS", WINDOW_START, WINDOW_END, fetchFn as unknown as typeof fetch),
		);
		await waitFor(() => expect(fetchFn).toHaveBeenCalled());
		expect(result.current).toEqual([]);
	});

	it("does not refetch when the caller passes a fresh fetch lambda each render", async () => {
		const inner = vi.fn(async () => jsonResponse({ data: [] }));
		const { rerender } = renderHook(() =>
			// A new function identity on every render — the shape any inline
			// `() => fetch(...)` caller has. Before the fix this sat in the effect's
			// dependency array and refetched forever.
			usePeaksForSpan("WCBS", WINDOW_START, WINDOW_END, (() =>
				inner()) as unknown as typeof fetch),
		);
		await waitFor(() => expect(inner).toHaveBeenCalledTimes(1));
		rerender();
		rerender();
		await waitFor(() => expect(inner).toHaveBeenCalledTimes(1));
	});
});

describe("overlappingSpans", () => {
	it("keeps a row that straddles either edge and drops one that misses entirely", () => {
		const rows = [
			// straddles the start
			{ id: 905, start_date: "2001-09-11T11:50:00", calc_duration: 1800, peaks: [[-1, 1]] },
			// straddles the end
			{ id: 906, start_date: "2001-09-11T12:25:00", calc_duration: 1800, peaks: [[-2, 2]] },
			// wholly before
			{ id: 907, start_date: "2001-09-11T11:00:00", calc_duration: 60, peaks: [[-3, 3]] },
			// wholly after
			{ id: 908, start_date: "2001-09-11T13:00:00", calc_duration: 60, peaks: [[-4, 4]] },
		];
		expect(overlappingSpans(rows, WINDOW_START, WINDOW_END).map((s) => s.peaks[0][1])).toEqual([
			1, 2,
		]);
	});

	it("drops a row with no id, since the id is the slot's only unique key", () => {
		const rows = [
			{ start_date: "2001-09-11T12:05:00", calc_duration: 10, peaks: [[-1, 1]] },
			{ id: 920, start_date: "2001-09-11T12:05:00", calc_duration: 20, peaks: [[-2, 2]] },
		];
		expect(overlappingSpans(rows, WINDOW_START, WINDOW_END).map((s) => s.id)).toEqual([920]);
	});

	it("drops rows with no usable duration rather than emitting a zero-width slot", () => {
		const rows = [
			{ id: 909, start_date: "2001-09-11T12:05:00", peaks: [[-1, 1]] },
			{ id: 910, start_date: "2001-09-11T12:06:00", calc_duration: 0, peaks: [[-2, 2]] },
			{ id: 911, start_date: "2001-09-11T12:07:00", calc_duration: 10, peaks: [[-3, 3]] },
		];
		const spans = overlappingSpans(rows, WINDOW_START, WINDOW_END);
		expect(spans).toHaveLength(1);
		expect(spans[0].endMs - spans[0].startMs).toBe(10_000);
	});
});
