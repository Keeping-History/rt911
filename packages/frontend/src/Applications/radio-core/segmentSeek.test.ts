import { describe, expect, it } from "vitest";
import { seekLanded, withStartFragment } from "./segmentSeek";

describe("withStartFragment", () => {
	it("appends a floored #t= fragment", () => {
		expect(withStartFragment("a.mp3", 420.9)).toBe("a.mp3#t=420");
	});
	it("replaces an existing fragment instead of stacking", () => {
		expect(withStartFragment("a.mp3#t=99", 10)).toBe("a.mp3#t=10");
	});
	it("omits the fragment at (or clamped to) zero", () => {
		expect(withStartFragment("a.mp3", 0)).toBe("a.mp3");
		expect(withStartFragment("a.mp3", -5)).toBe("a.mp3");
	});
});

describe("seekLanded", () => {
	const pending = { want: 420, atMs: 1_000, retried: false };
	it("accepts a landing within tolerance of the clock-adjusted target", () => {
		// 3s elapsed in flight → expected 423; landed at 424.
		expect(seekLanded(424, pending, 4_000, false)).toBe(true);
	});
	it("rejects an iOS-style clamp toward the file start", () => {
		expect(seekLanded(3, pending, 4_000, false)).toBe(false);
	});
	it("does not credit elapsed wall time while the clock is paused", () => {
		// Paused: expected stays 420 even after 100s in flight.
		expect(seekLanded(420, { ...pending, atMs: 0 }, 100_000, true)).toBe(true);
		expect(seekLanded(520, { ...pending, atMs: 0 }, 100_000, true)).toBe(false);
	});
});
