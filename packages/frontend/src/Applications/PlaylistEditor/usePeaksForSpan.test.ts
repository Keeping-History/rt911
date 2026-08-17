import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePeaksForSpan } from "./usePeaksForSpan";

function jsonResponse(data: unknown, ok = true): Response {
	return { ok, json: async () => data } as Response;
}

describe("usePeaksForSpan", () => {
	it("returns recordings that have peaks, positioned by their own start/duration", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse({
				data: [
					{
						start_date: "2001-09-11T12:00:00",
						calc_duration: 30,
						peaks: [[-10, 10]],
					},
					// no peaks yet (compute-peaks hasn't reached this row) — dropped
					{ start_date: "2001-09-11T12:01:00", calc_duration: 20, peaks: [] },
				],
			}),
		);

		const { result } = renderHook(() =>
			usePeaksForSpan(
				"WCBS",
				Date.UTC(2001, 8, 11, 12, 0),
				Date.UTC(2001, 8, 11, 12, 30),
				fetchFn as unknown as typeof fetch,
			),
		);

		await waitFor(() => expect(result.current).toHaveLength(1));
		expect(result.current[0]).toEqual({
			startMs: Date.UTC(2001, 8, 11, 12, 0),
			endMs: Date.UTC(2001, 8, 11, 12, 0) + 30_000,
			peaks: [[-10, 10]],
		});
	});

	it("filters by the station's source slug", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({ data: [] }));
		renderHook(() =>
			usePeaksForSpan(
				"WCBS",
				Date.UTC(2001, 8, 11, 12, 0),
				Date.UTC(2001, 8, 11, 12, 30),
				fetchFn as unknown as typeof fetch,
			),
		);
		await waitFor(() => expect(fetchFn).toHaveBeenCalled());
		const url = String((fetchFn.mock.calls[0] as unknown[])[0]);
		expect(url).toContain("/items/mp3_items?");
		expect(decodeURIComponent(url)).toContain("filter[source][slug][_eq]=WCBS");
	});

	it("stays quiet (empty) on a failed fetch", async () => {
		const fetchFn = vi.fn(async () => jsonResponse({}, false));
		const { result } = renderHook(() =>
			usePeaksForSpan(
				"WCBS",
				Date.UTC(2001, 8, 11, 12, 0),
				Date.UTC(2001, 8, 11, 12, 30),
				fetchFn as unknown as typeof fetch,
			),
		);
		await waitFor(() => expect(fetchFn).toHaveBeenCalled());
		expect(result.current).toEqual([]);
	});
});
