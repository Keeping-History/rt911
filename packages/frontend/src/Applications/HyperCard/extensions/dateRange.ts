// The canonical virtual-clock range for 911realtime. The replay data window
// begins 2001-09-09T00:00:00Z (video-grabber/config.py) and the Weather
// almanac only carries 09-09…09-12, so the standard authored range is those
// four days. The `setDateTime` HyperCard action clamps into this window so a
// stack can't seek the desktop to an instant with no data.
//
// Widen CLOCK_RANGE_END_ISO here (e.g. to 2001-09-18) if the product range
// grows — it's the single source of truth for the clamp.
export const CLOCK_RANGE_START_ISO = "2001-09-09T00:00:00Z";
/** Exclusive-feeling upper bound: the end of 2001-09-12 (start of 09-13). */
export const CLOCK_RANGE_END_ISO = "2001-09-13T00:00:00Z";

const HAS_ZONE = /[zZ]$|[+-]\d\d:?\d\d$/;

/** Parse an ISO/naive datetime as UTC ms (naive → treated as UTC). */
export function parseClockMs(iso: string): number | null {
	const t = iso.trim();
	if (t === "") return null;
	const ms = Date.parse(HAS_ZONE.test(t) ? t : `${t}Z`);
	return Number.isNaN(ms) ? null : ms;
}

export interface ClampResult {
	/** The clamped instant as a UTC ISO string (…Z), ready for the clock seam. */
	iso: string;
	/** Epoch ms of the clamped instant. */
	ms: number;
	/** True when the requested instant fell outside the range and was moved. */
	clamped: boolean;
}

/**
 * Clamp a requested datetime into [start, end]. Returns null only when the
 * input is unparseable (an author typo) — callers should ignore that rather
 * than seeking to Invalid Date.
 */
export function clampClockIso(
	requested: string,
	startIso: string = CLOCK_RANGE_START_ISO,
	endIso: string = CLOCK_RANGE_END_ISO,
): ClampResult | null {
	const ms = parseClockMs(requested);
	if (ms === null) return null;
	const startMs = parseClockMs(startIso)!;
	const endMs = parseClockMs(endIso)!;
	const clampedMs = Math.min(Math.max(ms, startMs), endMs);
	return {
		iso: new Date(clampedMs).toISOString(),
		ms: clampedMs,
		clamped: clampedMs !== ms,
	};
}
