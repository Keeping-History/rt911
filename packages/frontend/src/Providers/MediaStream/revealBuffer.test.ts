import { describe, expect, it } from "vitest";
import { drainDue, partitionByDue } from "./revealBuffer";

const iso = (ms: number) => new Date(ms).toISOString();

describe("partitionByDue", () => {
	it("splits a window into already-due and still-future items", () => {
		const now = 1_000_000;
		const { due, future } = partitionByDue(
			[
				{ id: 1, start_date: iso(now - 5_000) }, // past → due
				{ id: 2, start_date: iso(now) }, // exactly now → due
				{ id: 3, start_date: iso(now + 5_000) }, // future
			],
			now,
		);
		expect(due.map((i) => i.id)).toEqual([1, 2]);
		expect(future.map((i) => i.id)).toEqual([3]);
	});
});

describe("drainDue", () => {
	it("reveals only entries the clock has reached and removes them from the buffer", () => {
		const buffer = new Map<number, { id: number; start_date: string }>();
		const base = 1_000_000;
		for (const [id, off] of [
			[1, 10_000],
			[2, 20_000],
			[3, 30_000],
		]) {
			buffer.set(id, { id, start_date: iso(base + off) });
		}

		// Before any item is due: nothing revealed, buffer intact.
		expect(drainDue(buffer, base).map((i) => i.id)).toEqual([]);
		expect(buffer.size).toBe(3);

		// Clock reaches the first item only — no bulk reveal of the later two.
		expect(drainDue(buffer, base + 10_000).map((i) => i.id)).toEqual([1]);
		expect(buffer.size).toBe(2);

		// Reaching the second reveals just it; the third stays buffered.
		expect(drainDue(buffer, base + 20_000).map((i) => i.id)).toEqual([2]);
		expect(buffer.has(3)).toBe(true);

		// Finally the third.
		expect(drainDue(buffer, base + 30_000).map((i) => i.id)).toEqual([3]);
		expect(buffer.size).toBe(0);
	});

	it("preserves forward-only pacing: a bulk future window never reveals at once", () => {
		// A 5-minute pager window delivered in one frame, every item in the future.
		const base = 2_000_000;
		const buffer = new Map<number, { id: number; start_date: string }>();
		for (let i = 0; i < 10; i++) {
			buffer.set(i, { id: i, start_date: iso(base + i * 30_000) }); // every 30s
		}

		// Advancing the clock one reveal-tick at a time must surface at most the
		// items due by that instant — never the whole window.
		let revealed = 0;
		for (let sec = 0; sec <= 270; sec += 30) {
			const due = drainDue(buffer, base + sec * 1000);
			revealed += due.length;
			// At each step, total revealed equals items whose offset <= sec.
			expect(revealed).toBe(Math.floor((sec * 1000) / 30_000) + 1);
		}
		// The last item (offset 270s) is revealed by the final step; none skipped.
		expect(buffer.size).toBe(0);
		expect(revealed).toBe(10);
	});
});
