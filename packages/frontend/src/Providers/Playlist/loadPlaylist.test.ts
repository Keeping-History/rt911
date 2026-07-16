import { describe, expect, it, vi } from "vitest";
import { loadPlaylist, playlistIdFromSearch } from "./loadPlaylist";

const validRow = {
	data: {
		id: "abc-123",
		title: "Period 3",
		status: "published",
		definition: { version: 1, mode: "annotate", entries: [] },
	},
};

const okFetch = (body: unknown) =>
	vi.fn(async (...args: Parameters<typeof fetch>) => {
		void args; // typed like fetch so mock.calls[0][0] is inspectable
		return new Response(JSON.stringify(body), { status: 200 });
	});

describe("playlistIdFromSearch", () => {
	it("extracts a well-formed id", () => {
		expect(playlistIdFromSearch("?playlist=abc-123")).toBe("abc-123");
	});
	it("returns null when absent or malformed", () => {
		expect(playlistIdFromSearch("")).toBeNull();
		expect(playlistIdFromSearch("?playlist=")).toBeNull();
		expect(playlistIdFromSearch("?playlist=has/slash")).toBeNull();
		expect(playlistIdFromSearch(`?playlist=${"x".repeat(65)}`)).toBeNull();
	});
});

describe("loadPlaylist", () => {
	it("returns title + parsed definition on success", async () => {
		const f = okFetch(validRow);
		const loaded = await loadPlaylist("abc-123", f);
		expect(loaded.title).toBe("Period 3");
		expect(loaded.definition.mode).toBe("annotate");
		expect(f).toHaveBeenCalledTimes(1);
		expect(String(f.mock.calls[0][0])).toContain("/items/playlists/abc-123");
	});
	it("throws playlist-unavailable on HTTP error", async () => {
		const f = vi.fn(async () => new Response("nope", { status: 403 }));
		await expect(loadPlaylist("abc-123", f)).rejects.toThrow("playlist-unavailable");
	});
	it("throws on unpublished status", async () => {
		const f = okFetch({ data: { ...validRow.data, status: "draft" } });
		await expect(loadPlaylist("abc-123", f)).rejects.toThrow("playlist-unavailable");
	});
	it("throws on a structurally invalid definition", async () => {
		const f = okFetch({ data: { ...validRow.data, definition: { version: 99 } } });
		await expect(loadPlaylist("abc-123", f)).rejects.toThrow("playlist-unavailable");
	});
});
