import { describe, expect, it, vi } from "vitest";
import { fetchMe, loginEmail, logout, providerLoginUrl } from "./authApi";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("providerLoginUrl", () => {
	it("builds the Directus SSO URL with an encoded redirect", () => {
		const url = providerLoginUrl("google", "https://beta.911realtime.org/");
		expect(url).toContain("/auth/login/google?redirect=");
		expect(url).toContain(encodeURIComponent("https://beta.911realtime.org/"));
	});
});

describe("fetchMe", () => {
	it("returns the user and sends credentials", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect((args[1] as RequestInit).credentials).toBe("include");
			return jsonResponse({ data: { id: "u1", email: "t@x.org", first_name: "T", last_name: null } });
		});
		expect((await fetchMe(f))?.id).toBe("u1");
	});
	it("returns null on 401 (anonymous)", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [] }, 401));
		expect(await fetchMe(f)).toBeNull();
	});
	it("throws on other failures", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [] }, 500));
		await expect(fetchMe(f)).rejects.toThrow();
	});
});

describe("loginEmail", () => {
	it("POSTs session mode and resolves on success", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(JSON.parse(String((args[1] as RequestInit).body))).toMatchObject({ mode: "session" });
			return jsonResponse({ data: {} });
		});
		await expect(loginEmail("t@x.org", "pw", f)).resolves.toBeUndefined();
	});
	it("throws the server's message on failure", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "Invalid user credentials." }] }, 401));
		await expect(loginEmail("t@x.org", "pw", f)).rejects.toThrow("Invalid user credentials.");
	});
});

describe("logout", () => {
	it("POSTs and swallows failures", async () => {
		const f = vi.fn(async () => new Response("x", { status: 500 }));
		await expect(logout(f)).resolves.toBeUndefined();
	});
});
