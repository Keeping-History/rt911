import { describe, expect, it } from "vitest";
import {
	BACKWARD_SEEK_THRESHOLD_MS,
	SEEK_THRESHOLD_MS,
	shouldSeek,
} from "./seekDetection";

const T0 = Date.parse("2001-09-11T12:40:00Z");

describe("shouldSeek", () => {
	it("treats an ordinary forward tick (~1 min) as NOT a seek", () => {
		expect(shouldSeek(T0, T0 + 60_000)).toBe(false);
	});

	it("treats a forward jump beyond the threshold as a seek", () => {
		expect(shouldSeek(T0, T0 + SEEK_THRESHOLD_MS + 1)).toBe(true);
	});

	it("does not seek on a forward move exactly at the threshold", () => {
		expect(shouldSeek(T0, T0 + SEEK_THRESHOLD_MS)).toBe(false);
	});

	it("treats a small backward rewind (< 1 min, over the backward threshold) as a seek", () => {
		// The reported bug: rewinding well under the 90s forward threshold used to
		// be ignored, silently dropping now-future items that had already been
		// drained from the reveal buffer.
		expect(shouldSeek(T0, T0 - 30_000)).toBe(true);
	});

	it("treats any large backward jump as a seek", () => {
		expect(shouldSeek(T0, T0 - 3_600_000)).toBe(true);
	});

	it("ignores a sub-threshold backward wobble (e.g. forced-clock drift)", () => {
		expect(shouldSeek(T0, T0 - (BACKWARD_SEEK_THRESHOLD_MS - 1))).toBe(false);
	});

	it("ignores a no-op re-render (same instant)", () => {
		expect(shouldSeek(T0, T0)).toBe(false);
	});
});
