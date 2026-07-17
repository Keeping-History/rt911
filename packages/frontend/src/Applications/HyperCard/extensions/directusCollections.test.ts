import { describe, expect, it, vi } from "vitest";
import {
	DIRECTUS_COLLECTIONS,
	DIRECTUS_URL,
	fetchDirectusAudioItem,
	fetchDirectusItem,
	fetchDirectusVideoItem,
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
