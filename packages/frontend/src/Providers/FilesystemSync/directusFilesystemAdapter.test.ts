import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClassicyFileSystemSnapshot } from "classicy";
import {
	directusFilesystemAdapter,
	setSyncUser,
	getSyncUser,
	getCachedFileId,
	pushCurrentTree,
	__resetFilesystemSyncStateForTests,
} from "./directusFilesystemAdapter";
import * as api from "./directusFilesystemApi";

const user = { id: "u1", email: "a@b.c" } as never;
const tree = { "Macintosh HD": { _type: "directory" } } as never;
const snap = (hash: string): ClassicyFileSystemSnapshot =>
	({ tree, hash, seq: 1, storageKey: "classicyStorage", timestamp: "t" }) as ClassicyFileSystemSnapshot;

beforeEach(() => __resetFilesystemSyncStateForTests());
afterEach(() => vi.restoreAllMocks());

describe("setSyncUser/getSyncUser", () => {
	it("holds the current user", () => {
		setSyncUser(user);
		expect(getSyncUser()).toBe(user);
		setSyncUser(null);
		expect(getSyncUser()).toBeNull();
	});
});

describe("onSnapshot", () => {
	it("does nothing when anonymous", async () => {
		const push = vi.spyOn(api, "pushTree");
		await directusFilesystemAdapter.onSnapshot?.(snap("h1"));
		expect(push).not.toHaveBeenCalled();
	});
	it("pushes once, then dedupes an identical hash", async () => {
		const push = vi.spyOn(api, "pushTree").mockResolvedValue("file-1");
		setSyncUser(user);
		await directusFilesystemAdapter.onSnapshot?.(snap("h1"));
		await directusFilesystemAdapter.onSnapshot?.(snap("h1")); // same hash -> skipped
		expect(push).toHaveBeenCalledTimes(1);
		expect(getCachedFileId("u1")).toBe("file-1");
	});
	it("does not advance dedupe state when the push fails (so it retries)", async () => {
		const push = vi.spyOn(api, "pushTree").mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce("file-1");
		setSyncUser(user);
		await expect(directusFilesystemAdapter.onSnapshot?.(snap("h1"))).rejects.toThrow();
		await directusFilesystemAdapter.onSnapshot?.(snap("h1")); // retried, not deduped
		expect(push).toHaveBeenCalledTimes(2);
	});
});

describe("reconcile", () => {
	it("returns useLocal when anonymous (no network)", async () => {
		const idSpy = vi.spyOn(api, "fetchFilesystemFileId");
		await expect(directusFilesystemAdapter.reconcile?.(snap("h1"))).resolves.toEqual({ action: "useLocal" });
		expect(idSpy).not.toHaveBeenCalled();
	});
	it("replaces with the remote tree and caches the file id", async () => {
		vi.spyOn(api, "fetchFilesystemFileId").mockResolvedValue("file-9");
		vi.spyOn(api, "downloadTree").mockResolvedValue(tree);
		setSyncUser(user);
		await expect(directusFilesystemAdapter.reconcile?.(snap("h1"))).resolves.toEqual({ action: "replace", tree });
		expect(getCachedFileId("u1")).toBe("file-9");
	});
	it("returns useLocal when there is no remote file", async () => {
		vi.spyOn(api, "fetchFilesystemFileId").mockResolvedValue(null);
		setSyncUser(user);
		await expect(directusFilesystemAdapter.reconcile?.(snap("h1"))).resolves.toEqual({ action: "useLocal" });
	});
});

describe("pushCurrentTree", () => {
	it("no-ops when anonymous and pushes for the current user otherwise", async () => {
		const push = vi.spyOn(api, "pushTree").mockResolvedValue("file-1");
		await pushCurrentTree(tree);
		expect(push).not.toHaveBeenCalled();
		setSyncUser(user);
		await pushCurrentTree(tree);
		expect(push).toHaveBeenCalledTimes(1);
		expect(getCachedFileId("u1")).toBe("file-1");
	});
});
