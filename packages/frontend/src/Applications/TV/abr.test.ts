import { describe, expect, it } from "vitest";
import {
	bufferedAheadSeconds,
	OPTIMISTIC_BANDWIDTH_ESTIMATE,
	TV_ABR_CONFIG,
	WATCHDOG_MIN_BUFFER_S,
} from "./abr";
import type { BufferedMedia } from "./abr";

/** Build a minimal media element stand-in with the given buffered ranges. */
export function fakeMedia(
	ranges: [number, number][],
	currentTime: number,
	over: Partial<BufferedMedia> = {},
): BufferedMedia {
	return {
		buffered: {
			length: ranges.length,
			start: (i: number) => ranges[i][0],
			end: (i: number) => ranges[i][1],
		} as TimeRanges,
		currentTime,
		paused: false,
		ended: false,
		...over,
	};
}

describe("TV_ABR_CONFIG", () => {
	it("carries the exact upward-biased knobs from the design spec", () => {
		expect(TV_ABR_CONFIG).toEqual({
			abrEwmaDefaultEstimate: 5_000_000,
			abrBandWidthUpFactor: 0.9,
			abrEwmaFastVoD: 2,
			abrEwmaSlowVoD: 5,
		});
		expect(OPTIMISTIC_BANDWIDTH_ESTIMATE).toBe(5_000_000);
		expect(WATCHDOG_MIN_BUFFER_S).toBe(10);
	});
});

describe("bufferedAheadSeconds", () => {
	it("returns seconds remaining in the range containing the playhead", () => {
		expect(bufferedAheadSeconds(fakeMedia([[100, 160]], 130))).toBe(30);
	});

	it("returns 0 when the playhead sits in no buffered range", () => {
		expect(bufferedAheadSeconds(fakeMedia([[100, 160]], 200))).toBe(0);
		expect(bufferedAheadSeconds(fakeMedia([], 42))).toBe(0);
	});

	it("picks the correct range among several", () => {
		expect(
			bufferedAheadSeconds(fakeMedia([[0, 10], [100, 160]], 150)),
		).toBe(10);
	});
});
