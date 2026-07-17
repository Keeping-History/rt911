// Segment-bound resolution for the video embeds. An authored `start`/`end`
// bound may be written three ways; all resolve to a **stream offset in seconds**
// (seconds from the start of the channel's HLS stream), which is what the
// <video> element seeks to.
//
//   1. a number            → that many seconds into the stream (an offset)
//   2. "M:SS" / "H:MM:SS"  → a duration offset into the stream
//   3. a date-bearing time → a 9/11 wall-clock instant (e.g.
//      "2001-09-11T12:46:00"), mapped to an offset of (instant − channelStart).
//
// Bare clock strings ("08:46") are treated as *offsets* (case 2), never
// wall-clock — only a value carrying a calendar date (case 3) is mapped against
// the channel start. Directus stores `start_date` as a naive-UTC string, so
// wall-clock bounds must be written in that same UTC frame to line up.

/** True when the string carries a calendar date (YYYY-MM-DD…). */
const HAS_DATE = /\d{4}-\d{2}-\d{2}/;
/** "M:SS" or "H:MM:SS" (optionally fractional seconds). */
const CLOCK = /^(\d+):([0-5]?\d)(?::([0-5]?\d(?:\.\d+)?))?$/;

/**
 * Parse a naive datetime string as UTC. A trailing `Z`/offset is honoured; a
 * naive value (Directus' convention) is pinned to UTC by appending `Z`.
 * Returns null if unparseable.
 */
export function toUtcMs(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
	const ms = Date.parse(hasZone ? trimmed : `${trimmed}Z`);
	return Number.isNaN(ms) ? null : ms;
}

/** Parse "M:SS" / "H:MM:SS" to seconds; null if it isn't a clock string. */
export function parseClock(value: string): number | null {
	const m = CLOCK.exec(value.trim());
	if (!m) return null;
	const h = m[3] !== undefined ? Number(m[1]) : 0;
	const min = m[3] !== undefined ? Number(m[2]) : Number(m[1]);
	const sec = m[3] !== undefined ? Number(m[3]) : Number(m[2]);
	return h * 3600 + min * 60 + sec;
}

/**
 * Resolve an authored bound to a stream offset in seconds, or `undefined` if it
 * is absent/uninterpretable. `channelStartMs` is the channel `start_date` as
 * UTC ms (from {@link toUtcMs}); it is only needed for wall-clock bounds.
 */
export function parseBoundToSeconds(
	value: string | number | undefined | null,
	channelStartMs: number | null,
): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, value) : undefined;

	const str = value.trim();

	// Wall-clock instant → offset from the channel start.
	if (HAS_DATE.test(str)) {
		const boundMs = toUtcMs(str);
		if (boundMs === null || channelStartMs === null) return undefined;
		return Math.max(0, (boundMs - channelStartMs) / 1000);
	}

	// Clock duration ("M:SS" / "H:MM:SS").
	const clock = parseClock(str);
	if (clock !== null) return clock;

	// Plain numeric string.
	const num = Number(str);
	return Number.isFinite(num) ? Math.max(0, num) : undefined;
}

export interface ResolvedSegment {
	/** Seek origin in seconds (clamped ≥ 0). */
	startSec: number;
	/** End of the window in seconds, or undefined = play to the end. */
	endSec?: number;
}

/**
 * Combine authored start/end bounds into a normalized segment. A start past the
 * end (or non-positive span) drops the end so the clip just plays from start.
 */
export function resolveSegment(
	start: string | number | undefined | null,
	end: string | number | undefined | null,
	channelStartMs: number | null,
): ResolvedSegment {
	const startSec = parseBoundToSeconds(start, channelStartMs) ?? 0;
	const endSec = parseBoundToSeconds(end, channelStartMs);
	if (endSec !== undefined && endSec <= startSec) return { startSec };
	return { startSec, endSec };
}
