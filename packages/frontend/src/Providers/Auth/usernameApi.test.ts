import { describe, expect, it, vi } from "vitest";
import { checkUsername } from "./usernameApi";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("checkUsername", () => {
	it("reports a free name as available", async () => {
		const f = vi.fn(async () => json({ available: true }));
		await expect(checkUsername("danny", undefined, f as unknown as typeof fetch)).resolves.toBe("available");
	});

	it("reports a held name as taken", async () => {
		const f = vi.fn(async () => json({ available: false }));
		await expect(checkUsername("danny", undefined, f as unknown as typeof fetch)).resolves.toBe("taken");
	});

	it("sends credentials so the streamer can resolve the session", async () => {
		// Without the cookie the endpoint answers 401 and the check is useless.
		const f = vi.fn<typeof fetch>(async () => json({ available: true }));
		await checkUsername("danny", undefined, f);
		expect((f.mock.calls[0]?.[1] as RequestInit).credentials).toBe("include");
	});

	it("says unknown rather than taken when the server errors", async () => {
		// A check that cannot reach the server has no opinion. Reporting "taken"
		// would block a name that is very likely free, on no evidence.
		for (const status of [401, 429, 503]) {
			const f = vi.fn(async () => json({}, status));
			await expect(checkUsername("danny", undefined, f as unknown as typeof fetch)).resolves.toBe("unknown");
		}
	});

	it("says unknown when the request throws", async () => {
		const f = vi.fn(async () => {
			throw new Error("network down");
		});
		await expect(checkUsername("danny", undefined, f as unknown as typeof fetch)).resolves.toBe("unknown");
	});

	it("says unknown when the body is not the shape we expect", async () => {
		const f = vi.fn(async () => json({ available: "yes" }));
		await expect(checkUsername("danny", undefined, f as unknown as typeof fetch)).resolves.toBe("unknown");
	});

	it("escapes the name it puts in the query string", async () => {
		const f = vi.fn<typeof fetch>(async () => json({ available: true }));
		await checkUsername("a b&c", undefined, f);
		expect(String(f.mock.calls[0]?.[0])).toContain("name=a%20b%26c");
	});
});
