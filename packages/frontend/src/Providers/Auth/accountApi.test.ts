import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError } from "./authApi";
import { SETTINGS_KEYS, clearLocalSettings, deleteMyAccount, deleteMyData } from "./accountApi";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("deleteMyData", () => {
	it("POSTs to /profile/delete-data with credentials and no body", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("/profile/delete-data");
			const init = args[1] as RequestInit;
			expect(init.method).toBe("POST");
			expect(init.credentials).toBe("include");
			expect(init.body).toBeUndefined();
			return jsonResponse({ data: { deleted: { playlists: 2 }, failed: [] } });
		});
		const result = await deleteMyData(f);
		expect(result.deleted.playlists).toBe(2);
		expect(result.failed).toEqual([]);
	});

	it("maps 401/403 to the shared error classes", async () => {
		await expect(deleteMyData(vi.fn(async () => jsonResponse({}, 401)))).rejects.toBeInstanceOf(
			AuthRequiredError,
		);
		await expect(deleteMyData(vi.fn(async () => jsonResponse({}, 403)))).rejects.toBeInstanceOf(
			ForbiddenError,
		);
	});

	it("surfaces the server's message on failure", async () => {
		const f = vi.fn(async () =>
			jsonResponse({ errors: [{ message: "Could not delete your data." }] }, 500),
		);
		await expect(deleteMyData(f)).rejects.toThrow("Could not delete your data.");
	});
});

describe("deleteMyAccount", () => {
	it("POSTs to /profile/delete-account", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("/profile/delete-account");
			return jsonResponse({ data: { deleted: { account: 1 }, failed: [] } });
		});
		expect((await deleteMyAccount(f)).deleted.account).toBe(1);
	});

	it("rejects on 500 so the caller can skip the reload", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "boom" }] }, 500));
		await expect(deleteMyAccount(f)).rejects.toThrow("boom");
	});
});

describe("clearLocalSettings", () => {
	it("removes every persisted settings key", () => {
		const store = new Map<string, string>(SETTINGS_KEYS.map((k) => [k, "x"]));
		store.set("somethingElse", "keep");
		const storage = {
			removeItem: (k: string) => void store.delete(k),
		} as unknown as Storage;

		clearLocalSettings(storage);

		for (const key of SETTINGS_KEYS) expect(store.has(key)).toBe(false);
		expect(store.get("somethingElse")).toBe("keep");
	});

	it("includes the Classicy desktop state key", () => {
		// The single key holding every app's settings and window positions.
		// If this is ever dropped, "delete my data" silently keeps everything.
		expect(SETTINGS_KEYS).toContain("classicyDesktopState");
	});
});
