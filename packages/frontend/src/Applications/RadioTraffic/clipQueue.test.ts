import { describe, expect, it } from "vitest";
import {
	admissionSlot,
	type ClipQueueState,
	EMPTY_CLIP_QUEUE_STATE,
	reconcileClipQueue,
} from "./clipQueue";

describe("reconcileClipQueue", () => {
	it("admits up to the cap and queues the rest", () => {
		const state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2, 3, 4, 5], 3);
		expect(state.admitted).toEqual([1, 2, 3]);
		expect(state.pending).toEqual([4, 5]);
	});

	it("admits everything when the cap is not reached", () => {
		const state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2], 4);
		expect(state.admitted).toEqual([1, 2]);
		expect(state.pending).toEqual([]);
	});

	it("admits the oldest pending id the instant a slot frees up", () => {
		let state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2, 3], 2);
		expect(state.admitted).toEqual([1, 2]);
		expect(state.pending).toEqual([3]);

		// 1 finished (or scrolled out of LIVE) and is no longer desired.
		state = reconcileClipQueue(state, [2, 3], 2);
		expect(state.admitted).toEqual([2, 3]);
		expect(state.pending).toEqual([]);
	});

	it("never evicts an admitted id merely because a newer one arrived", () => {
		// The whole point of the feature: "always prefer playing out a clip
		// before starting a new one to overtake the queue."
		let state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2], 2);
		state = reconcileClipQueue(state, [1, 2, 3], 2);
		expect(state.admitted).toEqual([1, 2]);
		expect(state.pending).toEqual([3]);
	});

	it("drops an id from both lists the moment it stops being desired", () => {
		let state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2, 3], 1);
		expect(state.admitted).toEqual([1]);
		expect(state.pending).toEqual([2, 3]);

		// 2 left the live lane (a tag filter hid it, or it scrolled out) while
		// still pending — it must not linger waiting for a slot it will never
		// get registered for.
		state = reconcileClipQueue(state, [1, 3], 1);
		expect(state.admitted).toEqual([1]);
		expect(state.pending).toEqual([3]);
	});

	describe("a live change to the cap", () => {
		it("admits more immediately when the cap is raised", () => {
			let state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2, 3, 4], 2);
			expect(state.admitted).toEqual([1, 2]);

			state = reconcileClipQueue(state, [1, 2, 3, 4], 4);
			expect(state.admitted).toEqual([1, 2, 3, 4]);
			expect(state.pending).toEqual([]);
		});

		it("does not evict an already-admitted id when the cap is lowered", () => {
			let state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2, 3, 4], 4);
			expect(state.admitted).toEqual([1, 2, 3, 4]);

			state = reconcileClipQueue(state, [1, 2, 3, 4], 2);
			// Still all four playing — a lowered cap only throttles future
			// admissions, it must never yank a clip out from under a listener.
			expect(state.admitted).toEqual([1, 2, 3, 4]);
			expect(state.pending).toEqual([]);
		});

		it("stops pulling from pending once the lowered cap is back in range", () => {
			let state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2, 3, 4], 4);
			state = reconcileClipQueue(state, [1, 2, 3, 4], 2);
			// 1 and 2 leave; only one new arrival (5) should be admitted, because
			// the cap is now 2 and 3, 4 are still holding their slots.
			state = reconcileClipQueue(state, [3, 4, 5], 2);
			expect(state.admitted).toEqual([3, 4]);
			expect(state.pending).toEqual([5]);
		});
	});

	it("returns the same object when nothing changed", () => {
		const state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2, 3], 2);
		const next = reconcileClipQueue(state, [1, 2, 3], 2);
		expect(next).toBe(state);
	});

	it("is a fresh object when the pending order changed even if admitted did not", () => {
		const state = reconcileClipQueue(EMPTY_CLIP_QUEUE_STATE, [1, 2, 3], 2);
		const next = reconcileClipQueue(state, [1, 2, 4], 2);
		expect(next).not.toBe(state);
		expect(next.admitted).toEqual([1, 2]);
		expect(next.pending).toEqual([4]);
	});
});

describe("admissionSlot", () => {
	const state: ClipQueueState = { admitted: [10, 20, 30], pending: [40] };

	it("reports the index among currently-admitted ids", () => {
		expect(admissionSlot(state, 10)).toBe(0);
		expect(admissionSlot(state, 20)).toBe(1);
		expect(admissionSlot(state, 30)).toBe(2);
	});

	it("reports undefined for a pending id", () => {
		expect(admissionSlot(state, 40)).toBeUndefined();
	});

	it("reports undefined for an id the queue does not know at all", () => {
		expect(admissionSlot(state, 999)).toBeUndefined();
	});
});
