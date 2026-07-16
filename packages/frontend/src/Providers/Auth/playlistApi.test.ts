import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError } from "./authApi";
import {
	createPlaylist,
	deletePlaylist,
	duplicatePlaylist,
	getPlaylist,
	listMine,
	updatePlaylist,
} from "./playlistApi";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

const VALID_DEFINITION = { version: 1, mode: "restrict", entries: [] };
const INVALID_DEFINITION = { version: 99 };

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: "p1",
	title: "Period 3",
	status: "draft",
	date_updated: "2026-07-16T00:00:00Z",
	user_created: "teacher-1",
	...overrides,
});

describe("listMine", () => {
	it("fetches with the documented query and filters to meId", async () => {
		const rows = [row({ id: "mine", user_created: "teacher-1" }), row({ id: "theirs", user_created: "teacher-2" })];
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain(
				"/items/playlists?fields=id,title,status,date_updated,user_created&sort=-date_updated&limit=200",
			);
			expect((args[1] as RequestInit).credentials).toBe("include");
			return jsonResponse({ data: rows });
		});
		const result = await listMine("teacher-1", f);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("mine");
	});
});

describe("createPlaylist local validation", () => {
	it("rejects an invalid definition without calling fetch", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			void args;
			return jsonResponse({ data: row() });
		});
		await expect(createPlaylist("Untitled", INVALID_DEFINITION, f)).rejects.toThrow();
		expect(f).not.toHaveBeenCalled();
	});

	it("sends status:draft on a valid definition", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			const init = args[1] as RequestInit;
			expect(init.method).toBe("POST");
			expect(init.credentials).toBe("include");
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			expect(body.status).toBe("draft");
			expect(body.title).toBe("Untitled");
			return jsonResponse({ data: row({ title: "Untitled" }) });
		});
		const created = await createPlaylist("Untitled", VALID_DEFINITION, f);
		expect(created.title).toBe("Untitled");
	});
});

describe("updatePlaylist local validation", () => {
	it("rejects an invalid definition without calling fetch", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			void args;
			return jsonResponse({ data: row() });
		});
		await expect(updatePlaylist("p1", { definition: INVALID_DEFINITION }, f)).rejects.toThrow();
		expect(f).not.toHaveBeenCalled();
	});
});

describe("shared response handling", () => {
	it("maps 403 to ForbiddenError", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "not yours" }] }, 403));
		await expect(updatePlaylist("p1", { title: "x" }, f)).rejects.toThrow(ForbiddenError);
	});
	it("maps 401 to AuthRequiredError", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "sign in" }] }, 401));
		await expect(updatePlaylist("p1", { title: "x" }, f)).rejects.toThrow(AuthRequiredError);
	});
	it("throws a plain Error with the server message on other failures", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "boom" }] }, 500));
		await expect(updatePlaylist("p1", { title: "x" }, f)).rejects.toThrow("boom");
	});
});

describe("getPlaylist", () => {
	it("fetches the single row with credentials", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("/items/playlists/p1");
			expect((args[1] as RequestInit).credentials).toBe("include");
			return jsonResponse({ data: row({ definition: VALID_DEFINITION }) });
		});
		const got = await getPlaylist("p1", f);
		expect(got.id).toBe("p1");
		expect(got.definition).toEqual(VALID_DEFINITION);
	});
});

describe("deletePlaylist", () => {
	it("DELETEs with credentials and resolves on success", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect((args[1] as RequestInit).method).toBe("DELETE");
			expect((args[1] as RequestInit).credentials).toBe("include");
			return new Response(null, { status: 204 });
		});
		await expect(deletePlaylist("p1", f)).resolves.toBeUndefined();
	});
	it("maps 403 to ForbiddenError", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "not yours" }] }, 403));
		await expect(deletePlaylist("p1", f)).rejects.toThrow(ForbiddenError);
	});
});

describe("duplicatePlaylist", () => {
	it("composes 'Copy of <title>' via two sequential calls", async () => {
		const calls: string[] = [];
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			const url = String(args[0]);
			const init = args[1] as RequestInit;
			calls.push(`${init.method ?? "GET"} ${url}`);
			if ((init.method ?? "GET") === "GET" || init.method === undefined) {
				return jsonResponse({ data: row({ id: "p1", title: "Period 3", definition: VALID_DEFINITION }) });
			}
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			return jsonResponse({ data: row({ id: "p2", title: body.title as string, definition: body.definition }) });
		});
		const copy = await duplicatePlaylist("p1", f);
		expect(copy.title).toBe("Copy of Period 3");
		expect(f).toHaveBeenCalledTimes(2);
		expect(f.mock.calls[0][1] ? (f.mock.calls[0][1] as RequestInit).method ?? "GET" : "GET").toBe("GET");
		expect(String(f.mock.calls[0][0])).toContain("/items/playlists/p1");
		expect((f.mock.calls[1][1] as RequestInit).method).toBe("POST");
		expect(String(f.mock.calls[1][0])).toContain("/items/playlists");
		const secondBody = JSON.parse(String((f.mock.calls[1][1] as RequestInit).body)) as Record<string, unknown>;
		expect(secondBody.title).toBe("Copy of Period 3");
		expect(secondBody.status).toBe("draft");
	});
});
