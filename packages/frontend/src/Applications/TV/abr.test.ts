import { describe, expect, it } from "vitest";
import {
	bumpToLevel,
	bufferedAheadSeconds,
	OPTIMISTIC_BANDWIDTH_ESTIMATE,
	TV_ABR_CONFIG,
	WATCHDOG_MIN_BUFFER_S,
} from "./abr";
import type { BufferedMedia, HlsAbrApi } from "./abr";

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

/** Fake hls.js api that records once-handlers so tests can fire events. */
export function fakeApi(over: Partial<HlsAbrApi> = {}) {
	const handlers: Record<string, (() => void)[]> = {};
	const api: HlsAbrApi = {
		autoLevelCapping: -1,
		autoLevelEnabled: true,
		bandwidthEstimate: 500_000,
		currentLevel: 0,
		loadLevel: 0,
		nextLevel: -1,
		nextLoadLevel: 0,
		once: (event, cb) => {
			(handlers[event] ??= []).push(cb);
		},
		...over,
	};
	return { api, handlers };
}

describe("bumpToLevel", () => {
	it("resets the estimate, forces the level, then restores auto on switch", () => {
		const { api, handlers } = fakeApi();
		bumpToLevel(api, 2);
		expect(api.bandwidthEstimate).toBe(OPTIMISTIC_BANDWIDTH_ESTIMATE);
		expect(api.nextLevel).toBe(2);
		// hls.js fires hlsLevelSwitched once the forced switch lands.
		expect(handlers.hlsLevelSwitched).toHaveLength(1);
		handlers.hlsLevelSwitched[0]();
		expect(api.nextLevel).toBe(-1); // back to auto — never frozen at full
	});

	it("only refreshes the estimate when already playing the target level", () => {
		const { api, handlers } = fakeApi({ currentLevel: 2 });
		bumpToLevel(api, 2);
		expect(api.bandwidthEstimate).toBe(OPTIMISTIC_BANDWIDTH_ESTIMATE);
		expect(api.nextLevel).toBe(-1); // no forced switch, no flush
		expect(handlers.hlsLevelSwitched).toBeUndefined();
	});
});
