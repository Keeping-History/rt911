import { describe, it, expect, vi } from "vitest";
import { fetchFilesystemFileId, downloadTree, pushTree } from "./directusFilesystemApi";
import { DIRECTUS_URL } from "../Playlist/loadPlaylist";

const res = (body: unknown, ok = true, status = 200): Response =>
	({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const tree = { "Macintosh HD": { _type: "directory" } } as never;

describe("fetchFilesystemFileId", () => {
	it("returns the linked file id from /users/me", async () => {
		const fetchFn = vi.fn().mockResolvedValue(res({ data: { filesystem: "file-1" } }));
		await expect(fetchFilesystemFileId(fetchFn)).resolves.toBe("file-1");
		expect(fetchFn).toHaveBeenCalledWith(
			`${DIRECTUS_URL}/users/me?fields=filesystem`,
			expect.objectContaining({ credentials: "include" }),
		);
	});
	it("returns null when unlinked or request fails", async () => {
		await expect(fetchFilesystemFileId(vi.fn().mockResolvedValue(res({ data: { filesystem: null } })))).resolves.toBeNull();
		await expect(fetchFilesystemFileId(vi.fn().mockResolvedValue(res({}, false, 401)))).resolves.toBeNull();
	});
});

describe("downloadTree", () => {
	it("downloads and returns a valid tree from /assets/{id}", async () => {
		const fetchFn = vi.fn().mockResolvedValue(res(tree));
		await expect(downloadTree("file-1", fetchFn)).resolves.toEqual(tree);
		expect(fetchFn).toHaveBeenCalledWith(
			`${DIRECTUS_URL}/assets/file-1`,
			expect.objectContaining({ credentials: "include" }),
		);
	});
	it("returns null on non-ok, unparseable, or invalid content", async () => {
		await expect(downloadTree("x", vi.fn().mockResolvedValue(res({}, false, 404)))).resolves.toBeNull();
		const garbage = { ok: true, status: 200, text: async () => "not json" } as Response;
		await expect(downloadTree("x", vi.fn().mockResolvedValue(garbage))).resolves.toBeNull();
	});
});

describe("pushTree", () => {
	it("overwrites the known file via PATCH /files/{id} and returns the same id", async () => {
		const fetchFn = vi.fn().mockResolvedValue(res({ data: { id: "file-1" } }));
		await expect(pushTree(tree, "file-1", fetchFn)).resolves.toBe("file-1");
		expect(fetchFn).toHaveBeenCalledWith(
			`${DIRECTUS_URL}/files/file-1`,
			expect.objectContaining({ method: "PATCH", credentials: "include" }),
		);
	});
	it("creates a new file then links it to the user when no id is known", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(res({ data: { filesystem: null } })) // discovery: /users/me
			.mockResolvedValueOnce(res({ data: { id: "new-file" } }))    // POST /files
			.mockResolvedValueOnce(res({ data: {} }));                    // PATCH /users/me
		await expect(pushTree(tree, null, fetchFn)).resolves.toBe("new-file");
		expect(fetchFn.mock.calls[1][0]).toBe(`${DIRECTUS_URL}/files`);
		expect(fetchFn.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include" });
		expect(fetchFn.mock.calls[2][0]).toBe(`${DIRECTUS_URL}/users/me`);
		expect(JSON.parse((fetchFn.mock.calls[2][1] as RequestInit).body as string)).toEqual({ filesystem: "new-file" });
	});
	it("throws when the overwrite request fails", async () => {
		await expect(pushTree(tree, "file-1", vi.fn().mockResolvedValue(res({}, false, 500)))).rejects.toThrow();
	});
});
