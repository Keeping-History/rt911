import { describe, expect, it } from "vitest";
import { isSilentAt, MIN_SILENCE_MS, silenceFloor } from "./silence";

// 480 buckets over 480 seconds, so one bucket is exactly one second and a
// position in ms reads directly as a bucket index. The real envelope is always
// 480 buckets whatever the duration (docs/peaks.md); pinning the duration to
// match is what keeps these cases readable rather than a division exercise.
const BUCKETS = 480;
const DURATION_MS = 480_000;

const envelope = (fill: number): [number, number][] =>
	Array.from({ length: BUCKETS }, () => [-fill, fill] as [number, number]);

/** The same envelope with one bucket made loud. */
const withLoudBucket = (fill: number, index: number, loud: number) => {
	const peaks = envelope(fill);
	peaks[index] = [-loud, loud];
	return peaks;
};

describe("silenceFloor", () => {
	it("is the absolute floor when the recording has no loud bucket to scale from", () => {
		// An end-to-end-silent recording has no loudest bucket worth a fraction of,
		// so the relative term is 0 and the absolute floor is the only thing left.
		expect(silenceFloor(envelope(0))).toBe(4);
	});

	it("scales to a tenth of the recording's own loudest bucket once that clears the floor", () => {
		expect(silenceFloor(withLoudBucket(1, 10, 110))).toBeCloseTo(11);
	});

	it("reads a bucket's amplitude off whichever half is larger", () => {
		// Buckets are [min, max] and the min is negative, so a loud negative
		// excursion with a quiet positive one is still a loud bucket. Reading only
		// `max` here would return the absolute floor instead of 10.
		expect(silenceFloor([[-100, 2]])).toBeCloseTo(10);
		expect(silenceFloor([[-2, 100]])).toBeCloseTo(10);
	});
});

describe("isSilentAt", () => {
	it("is not silence when the item has no envelope at all", () => {
		// 59 of 814 items have no mp3_meta row, and the compute-peaks backfill has
		// not reached every one that does. UNKNOWN must never render as silence:
		// the badge would then mean both "this clip is quiet" and "we cannot tell".
		expect(isSilentAt({ durationMs: DURATION_MS, positionMs: 100_000 })).toBe(false);
	});

	it("is not silence when the envelope is present but empty", () => {
		expect(
			isSilentAt({ peaks: [], durationMs: DURATION_MS, positionMs: 100_000 }),
		).toBe(false);
	});

	it("is not silence when there is no playhead to look under", () => {
		// A card with no registered element has no position, so there is no bucket
		// range to inspect.
		expect(isSilentAt({ peaks: envelope(0), durationMs: DURATION_MS })).toBe(false);
	});

	it("is not silence when the clip's length is unknown", () => {
		// Without a duration there is no map from ms to bucket index at all.
		expect(
			isSilentAt({ peaks: envelope(0), durationMs: 0, positionMs: 100_000 }),
		).toBe(false);
	});

	it("is silence in the middle of an all-quiet stretch", () => {
		expect(
			isSilentAt({ peaks: envelope(1), durationMs: DURATION_MS, positionMs: 100_000 }),
		).toBe(true);
	});

	it("is silence for an all-zero envelope, via the absolute floor", () => {
		// Nothing to calibrate against: the relative floor is 0 here, so only the
		// absolute one can call this quiet.
		expect(
			isSilentAt({ peaks: envelope(0), durationMs: DURATION_MS, positionMs: 100_000 }),
		).toBe(true);
	});

	it("is not silence for a uniformly quiet-but-present recording", () => {
		// Every bucket at 20 with the loudest at 24: the relative floor is 2.4, the
		// absolute floor 4, and 20 clears both. A recording that is merely faint is
		// still carrying traffic, and a fixed amplitude threshold is exactly what
		// would misreport it.
		expect(
			isSilentAt({
				peaks: withLoudBucket(20, 10, 24),
				durationMs: DURATION_MS,
				positionMs: 100_000,
			}),
		).toBe(false);
	});

	it("is silence for a quiet stretch of a hot recording, via the relative floor", () => {
		// Buckets at 8 would clear a fixed floor of 4, but this tape peaks at 110 —
		// 8 is nothing on it. Self-calibration is what makes one threshold work
		// across sources recorded at wildly different gains.
		expect(
			isSilentAt({
				peaks: withLoudBucket(8, 10, 110),
				durationMs: DURATION_MS,
				positionMs: 100_000,
			}),
		).toBe(true);
	});

	it("is not silence while a loud bucket is still inside the trailing window", () => {
		// Traffic two seconds ago, with MIN_SILENCE_MS at three: the gap is not
		// long enough yet.
		expect(
			isSilentAt({
				peaks: withLoudBucket(1, 98, 100),
				durationMs: DURATION_MS,
				positionMs: 100_000,
			}),
		).toBe(false);
	});

	it("is silence once the loud bucket has fallen out of the trailing window", () => {
		// Same envelope, ten seconds later. The window is trailing, not cumulative.
		expect(
			isSilentAt({
				peaks: withLoudBucket(1, 90, 100),
				durationMs: DURATION_MS,
				positionMs: 100_000,
			}),
		).toBe(true);
	});

	it("clears the instant traffic resumes under the playhead", () => {
		// The exit condition is ONE bucket, which is what makes the badge return to
		// normal on the next tick rather than after another window's wait.
		const peaks = withLoudBucket(1, 100, 100);
		expect(isSilentAt({ peaks, durationMs: DURATION_MS, positionMs: 99_000 })).toBe(
			true,
		);
		expect(isSilentAt({ peaks, durationMs: DURATION_MS, positionMs: 100_000 })).toBe(
			false,
		);
	});

	it("does not trip on a quiet gap shorter than MIN_SILENCE_MS", () => {
		// Traffic, then a two-second pause, then traffic: a real transmission gap,
		// and the badge must sit through it without saying a word. Walk the whole
		// gap a tick at a time rather than sampling one instant in it.
		const peaks = envelope(100);
		for (const i of [98, 99, 100]) peaks[i] = [-1, 1];
		for (let positionMs = 98_000; positionMs <= 100_999; positionMs += 250) {
			expect(isSilentAt({ peaks, durationMs: DURATION_MS, positionMs })).toBe(false);
		}
	});

	it("trips once the gap has run past MIN_SILENCE_MS", () => {
		// The same shape one bucket longer, to pin that the previous case fails for
		// the length of the gap and not because a gap can never be detected.
		const peaks = envelope(100);
		for (const i of [98, 99, 100, 101]) peaks[i] = [-1, 1];
		expect(isSilentAt({ peaks, durationMs: DURATION_MS, positionMs: 101_000 })).toBe(
			true,
		);
	});

	it("is not silence before there is a full window of evidence", () => {
		// The opening of a clip: nothing behind the playhead to have been quiet for.
		expect(
			isSilentAt({ peaks: envelope(0), durationMs: DURATION_MS, positionMs: 0 }),
		).toBe(false);
		expect(
			isSilentAt({
				peaks: envelope(0),
				durationMs: DURATION_MS,
				positionMs: MIN_SILENCE_MS - 1,
			}),
		).toBe(false);
		expect(
			isSilentAt({
				peaks: envelope(0),
				durationMs: DURATION_MS,
				positionMs: MIN_SILENCE_MS,
			}),
		).toBe(true);
	});

	it("is not silence for a playhead past the end of the envelope", () => {
		// Playback has finished, or the duration and the envelope disagree. Either
		// way there is no audio under the playhead to call quiet.
		expect(
			isSilentAt({
				peaks: envelope(0),
				durationMs: DURATION_MS,
				positionMs: DURATION_MS + 60_000,
			}),
		).toBe(false);
	});

	it("clamps a playhead just past the last bucket rather than reading off the end", () => {
		// Rounding can put the playhead a hair beyond the final bucket. That must
		// still inspect the last bucket, not index past the array into undefined.
		expect(
			isSilentAt({
				peaks: envelope(0),
				durationMs: DURATION_MS,
				positionMs: DURATION_MS + 100,
			}),
		).toBe(true);
		expect(
			isSilentAt({
				peaks: withLoudBucket(1, BUCKETS - 1, 100),
				durationMs: DURATION_MS,
				positionMs: DURATION_MS + 100,
			}),
		).toBe(false);
	});

	it("works on a long recording, where one bucket spans a whole minute", () => {
		// The 8h18m tape: 480 buckets over 29,880,000ms is a 62-second bucket, so
		// the trailing window collapses to one or two buckets. Because buckets are
		// EXTREMES, that only makes silence harder to claim — never wrongly claimed.
		const longMs = 29_880_000;
		expect(
			isSilentAt({ peaks: envelope(1), durationMs: longMs, positionMs: 5_000_000 }),
		).toBe(true);
		expect(
			isSilentAt({
				peaks: withLoudBucket(1, Math.floor(5_000_000 / (longMs / BUCKETS)), 100),
				durationMs: longMs,
				positionMs: 5_000_000,
			}),
		).toBe(false);
	});
});
