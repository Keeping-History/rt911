import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTimelineMeta } from "./resolveTimelineMeta";
import type { EditorEntry } from "./editorState";

afterEach(() => vi.clearAllMocks());

const entries: EditorEntry[] = [
	{ uid: "n1", entry: { kind: "media", app: "news", itemId: "42" } },
	{ uid: "n2", entry: { kind: "media", app: "news", itemId: "43" }, timelineMeta: { publishedAt: "2001-09-11T10:00:00Z" } },
	{ uid: "f1", entry: { kind: "media", app: "flights", itemId: "AA11" } },
];

describe("resolveTimelineMeta", () => {
	it("looks up meta only for entries missing timelineMeta, keyed by uid", async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url.includes("/items/news_items/42")) {
				return new Response(JSON.stringify({ data: { start_date: "2001-09-11T12:00:00Z" } }));
			}
			if (url.includes("/items/flight_tracks")) {
				return new Response(JSON.stringify({
					data: [{ wheels_off_utc: "2001-09-11T11:59:00Z", wheels_on_utc: null }],
				}));
			}
			throw new Error(`unexpected url: ${url}`);
		});

		const result = await resolveTimelineMeta(entries, fetchFn as unknown as typeof fetch);

		expect(result.get("n1")).toEqual({ publishedAt: "2001-09-11T12:00:00Z" });
		expect(result.has("n2")).toBe(false); // already had timelineMeta — not fetched
		expect(result.get("f1")).toEqual({ departure: "2001-09-11T11:59:00Z", arrival: null });

		const urls = fetchFn.mock.calls.map((c) => c[0] as string);
		expect(urls.some((u) => u.includes("news_items/43"))).toBe(false);
	});
});
