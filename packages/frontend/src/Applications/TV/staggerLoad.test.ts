import { describe, expect, it } from "vitest";
import { STAGGER_THRESHOLD, computeConcurrency } from "./staggerLoad";

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
