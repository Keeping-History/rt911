import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadmeArticle } from "./useReadmeArticles";
import {
	ARTICLES_URL,
	PROBE_URL,
	REFRESH_INTERVAL_MS,
	sortArticles,
	useReadmeArticles,
} from "./useReadmeArticles";

const ARTICLES: ReadmeArticle[] = [
	{
		id: 2, headline: "Newer post", author: "Robbie Byrd",
		date_created: "2026-07-16T12:00:00", date_updated: null, body: "<p>Two</p>",
		sort: null, featured: false,
	},
	{
		id: 1, headline: "Welcome", author: "Robbie Byrd",
		date_created: "2026-07-01T12:00:00", date_updated: "2026-07-02T09:00:00", body: "<p>One</p>",
		sort: null, featured: false,
	},
];

function probeResponse(count: number, maxUpdated: string | null): Response {
	return {
		ok: true,
		json: async () => ({ data: [{ count, max: { date_updated: maxUpdated } }] }),
	} as unknown as Response;
}

function listResponse(articles: ReadmeArticle[]): Response {
	return { ok: true, json: async () => ({ data: articles }) } as unknown as Response;
}

// Let the mocked-fetch promise chains inside the hook settle under fake timers.
async function flush(ms = 0): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

describe("useReadmeArticles", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("probes then fetches the published list on mount, sequentially", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useReadmeArticles(true));
		expect(result.current.loading).toBe(true);

		await flush();
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();
		expect(result.current.articles).toEqual(ARTICLES);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenNthCalledWith(1, PROBE_URL, expect.objectContaining({ signal: expect.anything() }));
		expect(fetchMock).toHaveBeenNthCalledWith(2, ARTICLES_URL, expect.objectContaining({ signal: expect.anything() }));
	});

	it("does not refetch the list when the probe signature is unchanged", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES))
			.mockResolvedValue(probeResponse(2, "2026-07-02T09:00:00"));
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() => useReadmeArticles(true));
		await flush();
		await flush(REFRESH_INTERVAL_MS);

		// 2 initial + 1 probe — no third list fetch
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock).toHaveBeenLastCalledWith(PROBE_URL, expect.objectContaining({ signal: expect.anything() }));
	});

	it("refetches the list when the probe signature changes", async () => {
		const updated: ReadmeArticle[] = [
			{
				id: 3, headline: "Breaking", author: null,
				date_created: "2026-07-17T08:00:00", date_updated: null, body: "<p>Three</p>",
				sort: null, featured: false,
			},
			...ARTICLES,
		];
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES))
			.mockResolvedValueOnce(probeResponse(3, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(updated));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useReadmeArticles(true));
		await flush();
		await flush(REFRESH_INTERVAL_MS);

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(result.current.articles).toEqual(updated);
	});

	it("keeps the last-good list when a later probe fails", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES))
			.mockRejectedValue(new Error("network down"));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useReadmeArticles(true));
		await flush();
		await flush(REFRESH_INTERVAL_MS);

		expect(result.current.articles).toEqual(ARTICLES);
		expect(result.current.error).toBeNull();
	});

	it("reports an error only when nothing has ever loaded, then recovers on the next tick", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useReadmeArticles(true));
		await flush();
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBe("boom");

		await flush(REFRESH_INTERVAL_MS);
		expect(result.current.error).toBeNull();
		expect(result.current.articles).toEqual(ARTICLES);
	});

	it("never starts a new cycle while one is still in flight", async () => {
		// First probe hangs forever — later ticks must not stack requests.
		const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() => useReadmeArticles(true));
		await flush(REFRESH_INTERVAL_MS * 3);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does nothing when disabled", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() => useReadmeArticles(false));
		await flush(REFRESH_INTERVAL_MS);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stops polling on unmount", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(1, null))
			.mockResolvedValueOnce(listResponse(ARTICLES))
			.mockResolvedValue(probeResponse(1, null));
		vi.stubGlobal("fetch", fetchMock);

		const { unmount } = renderHook(() => useReadmeArticles(true));
		await flush();
		unmount();
		await flush(REFRESH_INTERVAL_MS * 2);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("sortArticles", () => {
	const mk = (o: Partial<ReadmeArticle> & { id: number }): ReadmeArticle => ({
		headline: `A${o.id}`, author: null, date_created: "2026-01-01T00:00:00",
		date_updated: null, body: "", sort: null, featured: false, ...o,
	});

	it("pins featured articles above everything, even sorted or newer ones", () => {
		const out = sortArticles([
			mk({ id: 1, sort: 1 }),
			mk({ id: 2, featured: true, date_created: "2020-01-01T00:00:00" }),
		]);
		expect(out.map((a) => a.id)).toEqual([2, 1]);
	});

	it("orders by manual sort ascending (smallest first)", () => {
		const out = sortArticles([mk({ id: 1, sort: 3 }), mk({ id: 2, sort: 1 }), mk({ id: 3, sort: 2 })]);
		expect(out.map((a) => a.id)).toEqual([2, 3, 1]);
	});

	it("puts unsorted (null) articles after sorted ones", () => {
		const out = sortArticles([mk({ id: 1, sort: null }), mk({ id: 2, sort: 5 })]);
		expect(out.map((a) => a.id)).toEqual([2, 1]);
	});

	it("breaks ties (equal sort, or both unsorted) by newest date first", () => {
		const out = sortArticles([
			mk({ id: 1, sort: 1, date_created: "2026-07-01T00:00:00" }),
			mk({ id: 2, sort: 1, date_created: "2026-07-10T00:00:00" }),
			mk({ id: 3, sort: null, date_created: "2026-06-01T00:00:00" }),
			mk({ id: 4, sort: null, date_created: "2026-06-15T00:00:00" }),
		]);
		expect(out.map((a) => a.id)).toEqual([2, 1, 4, 3]);
	});

	it("does not mutate its input", () => {
		const input = [mk({ id: 1, sort: 2 }), mk({ id: 2, sort: 1 })];
		sortArticles(input);
		expect(input.map((a) => a.id)).toEqual([1, 2]);
	});
});
