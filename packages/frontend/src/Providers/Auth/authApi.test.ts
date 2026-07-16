import { describe, expect, it, vi } from "vitest";
import { avatarUrl, fetchMe, loginEmail, logout, providerLoginUrl, uploadAvatar } from "./authApi";
import { DIRECTUS_URL } from "../Playlist/loadPlaylist";

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
			return jsonResponse({
				data: { id: "u1", email: "t@x.org", first_name: "T", last_name: null, avatar: null },
			});
		});
		expect((await fetchMe(f))?.id).toBe("u1");
	});
	it("requests the avatar field alongside the profile fields", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			expect(String(args[0])).toContain("fields=id,email,first_name,last_name,avatar");
			return jsonResponse({
				data: { id: "u1", email: "t@x.org", first_name: "T", last_name: null, avatar: "file-1" },
			});
		});
		expect((await fetchMe(f))?.avatar).toBe("file-1");
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

describe("avatarUrl", () => {
	it("builds the locked-preset asset URL", () => {
		expect(avatarUrl("file-1")).toBe(`${DIRECTUS_URL}/assets/file-1?key=avatar`);
	});
});

describe("uploadAvatar", () => {
	const file = new File([new ArrayBuffer(1)], "avatar.png", { type: "image/png" });

	it("uploads, patches, and deletes the previous avatar in order", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			const [url, init] = args;
			if (String(url).endsWith("/files") && (init as RequestInit).method === "POST") {
				expect((init as RequestInit).credentials).toBe("include");
				expect((init as RequestInit).body).toBeInstanceOf(FormData);
				return jsonResponse({ data: { id: "new-file" } });
			}
			if (String(url).endsWith("/users/me") && (init as RequestInit).method === "PATCH") {
				expect((init as RequestInit).credentials).toBe("include");
				expect(JSON.parse(String((init as RequestInit).body))).toEqual({ avatar: "new-file" });
				return jsonResponse({ data: {} });
			}
			if (String(url).endsWith("/files/old-file") && (init as RequestInit).method === "DELETE") {
				expect((init as RequestInit).credentials).toBe("include");
				return new Response(null, { status: 204 });
			}
			throw new Error(`unexpected call: ${String(url)}`);
		});

		const newId = await uploadAvatar(file, "old-file", f);
		expect(newId).toBe("new-file");

		expect(f.mock.calls).toHaveLength(3);
		expect(String(f.mock.calls[0][0])).toContain("/files");
		expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
		expect(String(f.mock.calls[1][0])).toContain("/users/me");
		expect((f.mock.calls[1][1] as RequestInit).method).toBe("PATCH");
		expect(String(f.mock.calls[2][0])).toContain("/files/old-file");
		expect((f.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
	});

	it("skips the DELETE call when there is no previous avatar", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			const [url, init] = args;
			if (String(url).endsWith("/files") && (init as RequestInit).method === "POST") {
				return jsonResponse({ data: { id: "new-file" } });
			}
			if (String(url).endsWith("/users/me") && (init as RequestInit).method === "PATCH") {
				return jsonResponse({ data: {} });
			}
			throw new Error(`unexpected call: ${String(url)}`);
		});

		const newId = await uploadAvatar(file, null, f);
		expect(newId).toBe("new-file");
		expect(f.mock.calls).toHaveLength(2);
	});

	it("swallows a failed DELETE of the previous avatar", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			const [url, init] = args;
			if (String(url).endsWith("/files") && (init as RequestInit).method === "POST") {
				return jsonResponse({ data: { id: "new-file" } });
			}
			if (String(url).endsWith("/users/me") && (init as RequestInit).method === "PATCH") {
				return jsonResponse({ data: {} });
			}
			if (String(url).endsWith("/files/old-file") && (init as RequestInit).method === "DELETE") {
				throw new Error("network down");
			}
			throw new Error(`unexpected call: ${String(url)}`);
		});

		await expect(uploadAvatar(file, "old-file", f)).resolves.toBe("new-file");
	});

	it("throws the server's message when the PATCH fails, and cleans up the orphaned upload", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			const [url, init] = args;
			if (String(url).endsWith("/files") && (init as RequestInit).method === "POST") {
				return jsonResponse({ data: { id: "new-file" } });
			}
			if (String(url).endsWith("/users/me") && (init as RequestInit).method === "PATCH") {
				return jsonResponse({ errors: [{ message: "Avatar rejected." }] }, 500);
			}
			if (String(url).endsWith("/files/new-file") && (init as RequestInit).method === "DELETE") {
				return new Response(null, { status: 204 });
			}
			throw new Error(`unexpected call: ${String(url)}`);
		});

		await expect(uploadAvatar(file, null, f)).rejects.toThrow("Avatar rejected.");

		expect(f.mock.calls).toHaveLength(3);
		expect(String(f.mock.calls[2][0])).toContain("/files/new-file");
		expect((f.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
	});

	it("still throws the PATCH error even when cleaning up the orphaned upload also fails", async () => {
		const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
			const [url, init] = args;
			if (String(url).endsWith("/files") && (init as RequestInit).method === "POST") {
				return jsonResponse({ data: { id: "new-file" } });
			}
			if (String(url).endsWith("/users/me") && (init as RequestInit).method === "PATCH") {
				return jsonResponse({ errors: [{ message: "Avatar rejected." }] }, 500);
			}
			if (String(url).endsWith("/files/new-file") && (init as RequestInit).method === "DELETE") {
				throw new Error("network down");
			}
			throw new Error(`unexpected call: ${String(url)}`);
		});

		await expect(uploadAvatar(file, null, f)).rejects.toThrow("Avatar rejected.");
	});

	it("throws the server's message when the upload fails", async () => {
		const f = vi.fn(async () => jsonResponse({ errors: [{ message: "File too large." }] }, 413));
		await expect(uploadAvatar(file, null, f)).rejects.toThrow("File too large.");
	});
});
