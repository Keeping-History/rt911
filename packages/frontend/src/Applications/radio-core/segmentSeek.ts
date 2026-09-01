// Clock-synced seeking that survives iOS Safari.
//
// Desktop browsers queue a `currentTime` write that points outside the
// currently buffered/seekable region of a long progressive file and perform
// it once the data exists. iOS Safari does not: the write is clamped to the
// nearest seekable position (often ~0 on a freshly loaded multi-hour mp3) or
// dropped outright — which left mobile station audio playing "at the same
// location" no matter where the virtual clock jumped. Two counter-measures,
// used by StationPlayer:
//
// 1. Position elements at LOAD time with a `#t=` media fragment on the src.
//    Safari resolves media fragments natively with a ranged fetch at the
//    target, so the element never needs a post-load seek to reach its start.
// 2. VERIFY every programmatic seek once the element reports `seeked`: if it
//    landed outside tolerance (a clamp), reload the element with a fresh
//    fragment instead of fighting `currentTime`.

/** How far a completed seek may land from its target before it counts as a
 *  clamp. Also absorbs the clock advancing while the seek was in flight. */
export const SEEK_LANDED_TOLERANCE_S = 5;

/** Replace any fragment on `url` with a `#t=` start-position media fragment. */
export function withStartFragment(url: string, seconds: number): string {
	const base = url.split("#")[0];
	const t = Math.max(0, Math.floor(seconds));
	return t > 0 ? `${base}#t=${t}` : base;
}

/** A seek awaiting its `seeked` verification. */
export interface PendingSeek {
	/** Target position, in media seconds, at the moment the seek was issued. */
	want: number;
	/** Wall-clock ms when the seek was issued (the clock keeps moving). */
	atMs: number;
	/** A fragment-reload fallback already ran for this intent — don't loop. */
	retried: boolean;
}

/**
 * Did the seek land? `want` is compared against where the clock will have
 * moved to while the seek was in flight (frozen clocks don't advance).
 */
export function seekLanded(
	currentTime: number,
	pending: PendingSeek,
	nowWallMs: number,
	clockPaused: boolean,
): boolean {
	const drift = clockPaused ? 0 : (nowWallMs - pending.atMs) / 1000;
	return Math.abs(currentTime - (pending.want + drift)) <= SEEK_LANDED_TOLERANCE_S;
}
