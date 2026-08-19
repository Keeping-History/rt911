// Is the clip quiet where the playhead is standing?
//
// Answered from `mp3_items.peaks` — the amplitude envelope the card is ALREADY
// holding and already drawing (RadioTraffic passes `meta={mp3Meta[id]}`, the
// card forwards `meta?.peaks` to PeaksWaveform). That is the whole design
// constraint: no second fetch, and no per-player Web Audio analyser. An
// AnalyserNode would need an AudioContext and a MediaElementSource per card,
// times every card in three lanes, to recompute at 44.1kHz something the
// compute-peaks pipeline already worked out offline and shipped in the frame.
//
// Two properties of the envelope make this cheap and safe:
//
//   Buckets are EXTREMES, not averages. peaks/extract.py stores
//   `[min(window) >> 8, max(window) >> 8]`, so a bucket reading quiet
//   GUARANTEES no loud sample anywhere in its span. Nothing needs smoothing,
//   and a false positive is not reachable by averaging a transient away.
//
//   There are 480 buckets whatever the duration, so a bucket is 0.63s on a
//   5-minute clip and 62s on the 8h18m tape. Coarse buckets degrade in the safe
//   direction for the same reason: a long recording yields FEWER silence
//   verdicts, never wrong ones.
//
// Stateless by construction — a verdict is a function of the envelope and the
// position in it. No timers, no refs, nothing to leak on unmount, and nothing
// that can disagree with itself between two cards showing the same clip.
//
// WHERE THE VERDICT GOES, and the precedence it takes when it gets there.
// A silence verdict is not itself a badge; it is one input to cardStatus's
// badgeFor, which ranks the card's conditions:
//
//   countdown  UPCOMING, always — the clip has no audio to be quiet
//   seeking    beats everything on a LIVE card: mid-seek the position is stale,
//              so both the drift number AND the bucket under it are noise
//   drift      beats silence. A card that is off the clock has to say so even
//              when the tape happens to be quiet, or the listener loses the
//              more important signal behind the less important one
//   silence    what is left: on the clock, playing, and carrying nothing
//
// That ordering is why isSilentAt is a predicate rather than a badge — it has no
// business knowing it can be outranked.
//
// The last step is NOT landed yet: `Badge` has no "silence" variant, because
// badgeLabel in TrafficCard.tsx switches exhaustively over that union and adding
// a sixth kind fails the build there until the switch gains a case. This module
// and its stylesheet rules are complete and tested; the three lines that join
// them to the badge are sequenced separately.

/** Peaks are int8-scaled by compute-peaks (see peaks/extract.py), so -128..127. */
const ABSOLUTE_FLOOR = 4;

/**
 * A bucket is quiet below this fraction of the recording's OWN loudest bucket.
 *
 * Self-calibrating on purpose: this corpus is 2001 scanner and ATC audio pulled
 * from a dozen sources recorded at wildly different gains, so one fixed
 * amplitude would read a hot tape as never silent and a faint one as always
 * silent. The absolute floor below it is what decides an end-to-end-silent
 * recording, where there is no loudest bucket to be a fraction of.
 */
const RELATIVE_FLOOR = 0.1;

/**
 * How long the audio must have been quiet before the badge will say so.
 *
 * This is the anti-flicker mechanism, and it is asymmetric on purpose: the
 * ENTRY condition is that every bucket in the trailing window is quiet, while
 * the EXIT condition is that the single bucket under the playhead is loud. A
 * half-second gap between two transmissions therefore cannot trip the badge,
 * and traffic resuming clears it on the very next tick. Because entry needs a
 * whole window and exit needs one bucket, the verdict cannot oscillate at the
 * ~4Hz rate the card polls its element.
 */
export const MIN_SILENCE_MS = 3_000;

/** How loud a bucket is, ignoring which half of the waveform it came from. */
const amplitude = (bucket: readonly number[]): number =>
	Math.max(Math.abs(bucket[0] ?? 0), Math.abs(bucket[1] ?? 0));

/** The amplitude below which a bucket counts as quiet, for THIS recording. */
export function silenceFloor(peaks: readonly (readonly number[])[]): number {
	const loudest = peaks.reduce((max, bucket) => Math.max(max, amplitude(bucket)), 0);
	return Math.max(ABSOLUTE_FLOOR, RELATIVE_FLOOR * loudest);
}

export interface SilenceArgs {
	/** `mp3_items.peaks` — absent for the items the backfill has not reached. */
	peaks?: readonly (readonly number[])[];
	/** The clip's length; without one there is no map from a position to a bucket. */
	durationMs: number;
	/** Where the playhead is, or undefined when the card has no element yet. */
	positionMs?: number;
}

/**
 * True only when the trailing {@link MIN_SILENCE_MS} of audio is all quiet.
 *
 * False is the answer for every kind of NOT KNOWING — no envelope, an empty
 * one, no playhead, no duration, a playhead past the end of the envelope, or a
 * playhead too early to have a full window behind it. Silence is a claim about
 * the recording, and a card that cannot check has not got one to make; saying
 * "Silence" because the data is missing would be the same badge for "this clip
 * is quiet" and "we have no idea", which is the one confusion worth avoiding.
 */
export function isSilentAt({ peaks, durationMs, positionMs }: SilenceArgs): boolean {
	if (!peaks?.length || durationMs <= 0 || positionMs === undefined) return false;
	// Too early to have MIN_SILENCE_MS of evidence behind us.
	if (positionMs < MIN_SILENCE_MS) return false;

	const bucketMs = durationMs / peaks.length;
	const last = peaks.length - 1;
	const from = Math.max(0, Math.floor((positionMs - MIN_SILENCE_MS) / bucketMs));
	// Past the end of the envelope: playback has run out, which is not silence.
	if (from > last) return false;
	const to = Math.min(Math.floor(positionMs / bucketMs), last);

	const floor = silenceFloor(peaks);
	for (let i = from; i <= to; i++) {
		if (amplitude(peaks[i]) >= floor) return false;
	}
	return true;
}
