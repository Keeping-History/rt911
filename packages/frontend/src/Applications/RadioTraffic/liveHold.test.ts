import { describe, expect, it } from "vitest";
import { nextHeldLiveIds, pruneIdleTouches, sameIdSet, withManualHold } from "./liveHold";

describe("withManualHold", () => {
	it("leaves UPCOMING and LIVE verdicts alone, held or not", () => {
		const held = new Set([1]);
		expect(withManualHold("upcoming", 1, held)).toBe("upcoming");
		expect(withManualHold("live", 1, held)).toBe("live");
	});

	it("overrides a PREVIOUS verdict for a held id", () => {
		expect(withManualHold("previous", 1, new Set([1]))).toBe("live");
	});

	it("leaves a PREVIOUS verdict alone for an id nobody is holding", () => {
		expect(withManualHold("previous", 2, new Set([1]))).toBe("previous");
	});

	it("never holds an id past an UPCOMING verdict — the acceptance criterion is about the LIVE→PREVIOUS edge only", () => {
		// heldLiveIds is only ever populated from items already in LIVE (see
		// nextHeldLiveIds below), so this is a belt-and-braces check on the
		// function's own contract, not a scenario the shell can actually reach.
		expect(withManualHold("upcoming", 1, new Set([1]))).toBe("upcoming");
	});
});

describe("nextHeldLiveIds", () => {
	const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

	it("holds every LIVE item the predicate calls touched", () => {
		const held = nextHeldLiveIds(items, (id) => id !== 2);
		expect([...held].sort()).toEqual([1, 3]);
	});

	it("holds nothing when nothing was touched", () => {
		expect(nextHeldLiveIds(items, () => false).size).toBe(0);
	});

	it("holds everything when everything was touched", () => {
		const held = nextHeldLiveIds(items, () => true);
		expect([...held].sort()).toEqual([1, 2, 3]);
	});

	it("only ever draws from the items handed to it", () => {
		// A predicate that would say yes to anything still cannot manufacture an
		// id that was not in the LIVE lane to begin with.
		const held = nextHeldLiveIds([{ id: 5 }], () => true);
		expect(held.has(999)).toBe(false);
		expect([...held]).toEqual([5]);
	});
});

describe("pruneIdleTouches", () => {
	it("keeps an id whose last activity is inside the idle window", () => {
		const touched = new Set([1]);
		const activity = new Map([[1, 9_000]]);
		expect(pruneIdleTouches(touched, activity, 10_000, 10_000)).toEqual(new Set([1]));
	});

	it("drops an id once its last activity is at least idleMs old", () => {
		const touched = new Set([1]);
		const activity = new Map([[1, 0]]);
		expect(pruneIdleTouches(touched, activity, 10_000, 10_000).has(1)).toBe(false);
	});

	it("drops an id with no recorded activity at all", () => {
		const touched = new Set([1]);
		expect(pruneIdleTouches(touched, new Map(), 10_000, 10_000).has(1)).toBe(false);
	});

	it("returns the same object when nothing was dropped", () => {
		const touched = new Set([1, 2]);
		const activity = new Map([
			[1, 5_000],
			[2, 5_000],
		]);
		expect(pruneIdleTouches(touched, activity, 6_000, 10_000)).toBe(touched);
	});

	it("keeps only the still-fresh ids out of several", () => {
		const touched = new Set([1, 2, 3]);
		const activity = new Map([
			[1, 0],
			[2, 9_999],
			[3, 5_000],
		]);
		expect([...pruneIdleTouches(touched, activity, 10_000, 10_000)].sort()).toEqual([2, 3]);
	});
});

describe("sameIdSet", () => {
	it("is true for two empty sets", () => {
		expect(sameIdSet(new Set(), new Set())).toBe(true);
	});

	it("is true for equal sets built in different orders", () => {
		expect(sameIdSet(new Set([1, 2, 3]), new Set([3, 1, 2]))).toBe(true);
	});

	it("is false when sizes differ", () => {
		expect(sameIdSet(new Set([1, 2]), new Set([1]))).toBe(false);
	});

	it("is false when sizes match but membership differs", () => {
		expect(sameIdSet(new Set([1, 2]), new Set([1, 3]))).toBe(false);
	});
});
