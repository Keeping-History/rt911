import { afterEach, describe, expect, it, vi } from "vitest";
import { directusGet, enqueue } from "./directusQueue";

afterEach(() => vi.clearAllMocks());

describe("enqueue", () => {
	it("runs jobs strictly one at a time, in order", async () => {
		let running = 0;
		let maxRunning = 0;
		const order: number[] = [];
		const job = (n: number) => async () => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 5));
			order.push(n);
			running -= 1;
			return n;
		};
		const results = await Promise.all([enqueue(job(1)), enqueue(job(2)), enqueue(job(3))]);
		expect(maxRunning).toBe(1);
		expect(order).toEqual([1, 2, 3]);
		expect(results).toEqual([1, 2, 3]);
	});

	it("keeps the chain alive after a rejection", async () => {
		await expect(enqueue(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		await expect(enqueue(async () => "ok")).resolves.toBe("ok");
	});
});

describe("directusGet", () => {
	it("GETs DIRECTUS_URL + path and unwraps data", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 1 }] })));
		const rows = await directusGet("/items/sources?fields=id", fetchFn as unknown as typeof fetch);
		expect(rows).toEqual([{ id: 1 }]);
		expect((fetchFn.mock.calls[0] as unknown[])[0]).toContain("/items/sources?fields=id");
	});

	it("throws on a non-ok response", async () => {
		const fetchFn = vi.fn(async () => new Response("{}", { status: 403 }));
		await expect(directusGet("/items/nope", fetchFn as unknown as typeof fetch)).rejects.toThrow();
	});
});
