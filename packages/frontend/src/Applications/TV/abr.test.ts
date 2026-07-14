import { describe, expect, it } from "vitest";
import {
	bumpToLevel,
	bufferedAheadSeconds,
	maybeProbeUp,
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

describe("maybeProbeUp", () => {
	const healthy = () => fakeMedia([[0, 100]], 50); // 50s buffered ahead

	it("probes one level up via nextLoadLevel when below the ceiling with a healthy buffer", () => {
		const { api } = fakeApi({ loadLevel: 0 });
		expect(maybeProbeUp(healthy(), api, 2)).toBe(true);
		expect(api.nextLoadLevel).toBe(1); // exactly one fragment, no flush
	});

	it("does nothing without an hls api (Safari native HLS)", () => {
		expect(maybeProbeUp(healthy(), undefined, 2)).toBe(false);
	});

	it("does nothing in manual mode (a bump is in flight)", () => {
		const { api } = fakeApi({ autoLevelEnabled: false, nextLoadLevel: 0 });
		expect(maybeProbeUp(healthy(), api, 2)).toBe(false);
		expect(api.nextLoadLevel).toBe(0);
	});

	it("never probes at or past the ceiling", () => {
		const { api } = fakeApi({ loadLevel: 1, nextLoadLevel: 1 });
		expect(maybeProbeUp(healthy(), api, 1)).toBe(false); // grid pinned at mid
		expect(api.nextLoadLevel).toBe(1);
	});

	it("skips paused or ended players", () => {
		const { api } = fakeApi();
		expect(maybeProbeUp(fakeMedia([[0, 100]], 50, { paused: true }), api, 2)).toBe(false);
		expect(maybeProbeUp(fakeMedia([[0, 100]], 50, { ended: true }), api, 2)).toBe(false);
	});

	it("skips when the buffer is thinner than WATCHDOG_MIN_BUFFER_S", () => {
		const { api } = fakeApi();
		expect(maybeProbeUp(fakeMedia([[0, 55]], 50), api, 2)).toBe(false); // 5s < 10s
	});
});
