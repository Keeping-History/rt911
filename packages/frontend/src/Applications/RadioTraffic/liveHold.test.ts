import { describe, expect, it } from "vitest";
import { nextHeldLiveIds, sameIdSet, withAudibleHold } from "./liveHold";

describe("withAudibleHold", () => {
	it("leaves UPCOMING and LIVE verdicts alone, held or not", () => {
		const held = new Set([1]);
		expect(withAudibleHold("upcoming", 1, held)).toBe("upcoming");
		expect(withAudibleHold("live", 1, held)).toBe("live");
	});

	it("overrides a PREVIOUS verdict for a held id", () => {
		expect(withAudibleHold("previous", 1, new Set([1]))).toBe("live");
	});

	it("leaves a PREVIOUS verdict alone for an id nobody is holding", () => {
		expect(withAudibleHold("previous", 2, new Set([1]))).toBe("previous");
	});

	it("never holds an id past an UPCOMING verdict — the acceptance criterion is about the LIVE→PREVIOUS edge only", () => {
		// heldLiveIds is only ever populated from items already in LIVE (see
		// nextHeldLiveIds below), so this is a belt-and-braces check on the
		// function's own contract, not a scenario the shell can actually reach.
		expect(withAudibleHold("upcoming", 1, new Set([1]))).toBe("upcoming");
	});
});

describe("nextHeldLiveIds", () => {
	const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

	it("holds every LIVE item the predicate calls audible", () => {
		const held = nextHeldLiveIds(items, (id) => id !== 2);
		expect([...held].sort()).toEqual([1, 3]);
	});

	it("holds nothing when nothing is audible", () => {
		expect(nextHeldLiveIds(items, () => false).size).toBe(0);
	});

	it("holds everything when everything is audible", () => {
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
