import { describe, expect, it } from "vitest";
import { STAGGER_THRESHOLD, computeConcurrency, bufferCapsForLevel } from "./staggerLoad";
import { type LoadPhase, markLoaded, reconcile, shouldMount } from "./staggerLoad";

describe("computeConcurrency", () => {
	it("does not stagger at or below the threshold (mount all)", () => {
		expect(computeConcurrency(4, {})).toBe(4);
		expect(computeConcurrency(1, {})).toBe(1);
		expect(STAGGER_THRESHOLD).toBe(4);
	});

	it("uses deviceMemory (GiB) as the cap above the threshold", () => {
		expect(computeConcurrency(23, { deviceMemory: 8 })).toBe(8);
		expect(computeConcurrency(23, { deviceMemory: 4 })).toBe(4);
	});

	it("clamps to the [2, 8] range", () => {
		expect(computeConcurrency(23, { deviceMemory: 0.5 })).toBe(2);
		expect(computeConcurrency(23, { deviceMemory: 64 })).toBe(8);
	});

	it("falls back to half the core count when deviceMemory is absent", () => {
		expect(computeConcurrency(23, { hardwareConcurrency: 12 })).toBe(6);
		expect(computeConcurrency(23, { hardwareConcurrency: 2 })).toBe(2);
	});

	it("falls back to the threshold when no signal is available", () => {
		expect(computeConcurrency(23, {})).toBe(4);
	});

	it("handles a zero core count by clamping to the floor of the range", () => {
		expect(computeConcurrency(23, { hardwareConcurrency: 0 })).toBe(2);
	});
});

const phases = (entries: [number, LoadPhase][]) => new Map(entries);

describe("reconcile", () => {
	it("promotes up to `concurrency` visible idle players to loading", () => {
		const next = reconcile(new Map(), {
			visibleIds: [1, 2, 3, 4, 5],
			priorityIds: [],
			concurrency: 2,
		});
		const loading = [...next].filter(([, p]) => p === "loading").map(([id]) => id);
		expect(loading.sort()).toEqual([1, 2]);
	});

	it("does not exceed the budget while players are still loading", () => {
		const prev = phases([[1, "loading"], [2, "loading"]]);
		const next = reconcile(prev, { visibleIds: [1, 2, 3, 4], priorityIds: [], concurrency: 2 });
		expect([...next].filter(([, p]) => p === "loading").length).toBe(2);
		expect(next.get(3)).toBe("idle");
	});

	it("frees capacity once a player has loaded, promoting the next", () => {
		const prev = phases([[1, "loaded"], [2, "loading"]]);
		const next = reconcile(prev, { visibleIds: [1, 2, 3, 4], priorityIds: [], concurrency: 2 });
		// 1 loaded (doesn't count), 2 still loading -> 1 slot free -> promote 3
		expect(next.get(3)).toBe("loading");
		expect(next.get(4)).toBe("idle");
	});

	it("promotes priority ids before other visible thumbnails", () => {
		const next = reconcile(new Map(), {
			visibleIds: [1, 2, 3, 4, 5],
			priorityIds: [5],
			concurrency: 1,
		});
		expect(next.get(5)).toBe("loading");
		expect(next.get(1)).toBe("idle");
	});

	it("prunes players that are no longer visible back to idle (unmount)", () => {
		const prev = phases([[1, "loaded"], [2, "loading"]]);
		const next = reconcile(prev, { visibleIds: [2], priorityIds: [], concurrency: 4 });
		expect(next.has(1)).toBe(false);
		expect(next.get(2)).toBe("loading");
	});
});

describe("markLoaded", () => {
	it("moves a loading player to loaded", () => {
		expect(markLoaded(phases([[1, "loading"]]), 1).get(1)).toBe("loaded");
	});
	it("is a no-op for ids that are not loading", () => {
		const prev = phases([[1, "idle"]]);
		expect(markLoaded(prev, 1).get(1)).toBe("idle");
		expect(markLoaded(prev, 99).has(99)).toBe(false);
	});
});

describe("shouldMount", () => {
	it("mounts loading and loaded players, not idle/unknown", () => {
		const p = phases([[1, "loading"], [2, "loaded"], [3, "idle"]]);
		expect(shouldMount(p, 1)).toBe(true);
		expect(shouldMount(p, 2)).toBe(true);
		expect(shouldMount(p, 3)).toBe(false);
		expect(shouldMount(p, 4)).toBe(false);
	});
});

describe("bufferCapsForLevel", () => {
	it("keeps thumbnails (lowest tier) on a tiny buffer", () => {
		const caps = bufferCapsForLevel(0);
		expect(caps.maxBufferLength).toBeLessThanOrEqual(6);
		expect(caps.backBufferLength).toBe(0);
		expect(caps.maxBufferSize).toBeLessThanOrEqual(10 * 1000 * 1000);
	});

	it("gives the focused player (highest tier) a larger buffer than a thumbnail", () => {
		expect(bufferCapsForLevel(2).maxBufferLength).toBeGreaterThan(
			bufferCapsForLevel(0).maxBufferLength,
		);
	});
});

