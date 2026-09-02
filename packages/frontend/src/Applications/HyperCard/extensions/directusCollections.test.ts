import { describe, expect, it, vi } from "vitest";
import {
	DIRECTUS_COLLECTIONS,
	DIRECTUS_URL,
	fetchDirectusAudioItem,
	fetchDirectusItem,
	fetchDirectusNewsItem,
	fetchDirectusNewsList,
	fetchDirectusPagerItem,
	fetchDirectusPagerList,
	fetchDirectusPagerProviders,
	fetchDirectusVideoItem,
	fetchDirectusVideoList,
} from "./directusCollections";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => body,
	} as unknown as Response;
}

describe("fetchDirectusItem", () => {
	it("builds a single-item URL with the projected fields and returns data", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 7, title: "Hi" } }));
		const item = await fetchDirectusItem<{ id: number; title: string }>(
			"mp3_items",
			7,
			["id", "title"],
			fetchFn,
		);
		expect(item).toEqual({ id: 7, title: "Hi" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toBe(`${DIRECTUS_URL}/items/mp3_items/7?fields=id,title`);
	});

	it("encodes collection, id and field names", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
		await fetchDirectusItem("odd items", "a/b", ["a,b"], fetchFn);
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toBe(`${DIRECTUS_URL}/items/odd%20items/a%2Fb?fields=a%2Cb`);
	});

	it("passes the abort signal through", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: {} }));
		const controller = new AbortController();
		await fetchDirectusItem("mp3_items", 1, ["id"], fetchFn, controller.signal);
		expect(fetchFn.mock.calls[0][1]).toEqual({ signal: controller.signal });
	});

	it("throws on a non-ok response", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false, 404));
		await expect(fetchDirectusItem("mp3_items", 9, ["id"], fetchFn)).rejects.toThrow("HTTP 404");
	});

	it("throws when the item is missing from the envelope", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: null }));
		await expect(fetchDirectusItem("mp3_items", 9, ["id"], fetchFn)).rejects.toThrow("not found");
	});
});

describe("fetchDirectusAudioItem", () => {
	it("targets the mp3_items collection with the audio field set", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse({ data: { id: 3, title: "Clip", url: "https://x/a.mp3" } }),
		);
		const item = await fetchDirectusAudioItem(3, fetchFn);
		expect(item.url).toBe("https://x/a.mp3");
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("/items/mp3_items/3?fields=");
		for (const field of DIRECTUS_COLLECTIONS.audio.fields) {
			expect(url).toContain(field);
		}
	});
});

describe("fetchDirectusVideoItem", () => {
	it("targets the tv_channels collection with the video field set", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse({ data: { id: 3, title: "WNYW", url: "https://x/ch3.m3u8" } }),
		);
		const item = await fetchDirectusVideoItem(3, fetchFn);
		expect(item.url).toBe("https://x/ch3.m3u8");
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("/items/tv_channels/3?fields=");
		for (const field of DIRECTUS_COLLECTIONS.video.fields) {
			expect(url).toContain(field);
		}
	});
});

describe("fetchDirectusNewsItem", () => {
	it("targets the news_items collection with the news field set", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse({ data: { id: 9, title: "Headline", content: "<p>hi</p>" } }),
		);
		const item = await fetchDirectusNewsItem(9, fetchFn);
		expect(item.content).toBe("<p>hi</p>");
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("/items/news_items/9?fields=");
		for (const field of DIRECTUS_COLLECTIONS.news.fields) {
			expect(url).toContain(field);
		}
	});
});

describe("fetchDirectusPagerItem", () => {
	it("targets the pager_items collection with the pager field set", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse({ data: { id: 5, message: "CALL OPS", provider: "SkyTel" } }),
		);
		const item = await fetchDirectusPagerItem(5, fetchFn);
		expect(item.message).toBe("CALL OPS");
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("/items/pager_items/5?fields=");
		for (const field of DIRECTUS_COLLECTIONS.pager.fields) {
			expect(url).toContain(field);
		}
	});
});

// --- List/search fetchers (issue #560 — HyperCard item pickers) -----------

describe("fetchDirectusVideoList", () => {
	it("requests every tv_channels row, sorted by source/title, and returns the data array", async () => {
		const rows = [{ id: 1, title: "WNYW", full_title: "WNYW Fox 5", source: "fox" }];
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: rows }));
		const result = await fetchDirectusVideoList(fetchFn);
		expect(result).toEqual(rows);
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("/items/tv_channels?");
		expect(url).toContain("fields=id,title,full_title,source");
		expect(url).toContain("sort=source,title");
	});

	it("throws when the request fails", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
		await expect(fetchDirectusVideoList(fetchFn)).rejects.toThrow("500");
	});
});

describe("fetchDirectusNewsList", () => {
	it("requests every news_items row, newest first", async () => {
		const rows = [{ id: 9, title: "Headline", full_title: "A Fuller Headline", start_date: "2001-09-11T12:46:00" }];
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: rows }));
		const result = await fetchDirectusNewsList(fetchFn);
		expect(result).toEqual(rows);
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("/items/news_items?");
		expect(url).toContain("fields=id,title,full_title,start_date");
		expect(url).toContain("sort=-start_date");
	});
});

describe("fetchDirectusPagerProviders", () => {
	it("returns the distinct, sorted, non-empty provider values", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			jsonResponse({ data: [{ provider: "SkyTel" }, { provider: "PageNet" }, { provider: null }] }),
		);
		const providers = await fetchDirectusPagerProviders(fetchFn);
		expect(providers).toEqual(["PageNet", "SkyTel"]);
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("/items/pager_items?");
		expect(url).toContain("groupBy=provider");
	});
});

describe("fetchDirectusPagerList", () => {
	it("requests every pager_items row, newest first, with no filters applied", async () => {
		const rows = [{ id: 5, message: "CALL OPS", provider: "SkyTel", recipient_id: "123", start_date: "x" }];
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: rows }));
		const result = await fetchDirectusPagerList({}, fetchFn);
		expect(result).toEqual(rows);
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("/items/pager_items?");
		expect(url).toContain("sort=-start_date");
		expect(url).not.toContain("filter%5B");
	});

	it("applies provider (exact), recipient and message (substring) filters", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
		await fetchDirectusPagerList({ provider: "SkyTel", recipient: "123", message: "OPS" }, fetchFn);
		const url = fetchFn.mock.calls[0][0] as string;
		expect(url).toContain("filter%5Bprovider%5D%5B_eq%5D=SkyTel");
		expect(url).toContain("filter%5Brecipient_id%5D%5B_icontains%5D=123");
		expect(url).toContain("filter%5Bmessage%5D%5B_icontains%5D=OPS");
	});
});
