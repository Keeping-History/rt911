// The two lines a collapsed player prints under its subject, and the zone it
// stamps them with.
//
// A module of its own rather than more of tabs/itemTiming because the collapsed
// player says these things DIFFERENTLY from the Details panel: the design's
// "9/11/2001 8:33 AM ET" and "68 seconds" against the panel's time-only
// "8:33:00 AM" and MM:SS "01:08". The INSTANTS still come from itemTiming — one
// answer about when a clip ran, two ways of saying it — and only the wording is
// here.

const HOUR_MS = 3_600_000;

/**
 * The zone the desktop's clock is currently displaying, as a listener names it.
 *
 * Eastern is the only offset this product really runs at — the clock is seeded
 * to UTC-4 on 2001-09-11 — and "ET" is what the design prints. It is still
 * DERIVED rather than written into the markup, because Classicy's Date & Time
 * control panel can move the offset, and a stamp that went on saying "ET" over
 * Pacific time would be a lie with nothing on screen to catch it.
 */
export function zoneLabel(tzOffsetHours: number): string {
	if (!Number.isFinite(tzOffsetHours)) return "UTC";
	// EDT and EST. Both are "ET" to a reader, and the app crosses between them
	// only if someone changes the offset by hand.
	if (tzOffsetHours === -4 || tzOffsetHours === -5) return "ET";
	if (tzOffsetHours === 0) return "UTC";
	return `UTC${tzOffsetHours > 0 ? "+" : "-"}${Math.abs(tzOffsetHours)}`;
}

/**
 * `9/11/2001 8:33 AM ET` — the collapsed player's start line, or just
 * `8:33 AM ET` when the clip started on the same (display-shifted) day the
 * virtual clock currently reads.
 *
 * Shift the true-UTC instant by the display offset and format it AS UTC, which
 * is itemTiming.wallClockLabel's trick and for the same reason: the line has to
 * read identically for a listener in Berlin and one in Boston, which handing
 * the raw instant to the browser's own zone would not. Unlike that helper this
 * one can carry the date, because a collapsed lane has no card header to carry
 * it — but only when the date is not simply "today" as the Classicy clock
 * currently sees it (issue #523). `nowMs` is the virtual clock's own current
 * instant (e.g. RadioTraffic's `anchorMs`), shifted by the same offset before
 * comparing — this is a "current day" question about the desktop's clock, not
 * the browser's real-world date.
 */
export function startLabel(
	ms: number | null,
	tzOffsetHours: number,
	nowMs: number | null,
): string | null {
	if (ms === null || !Number.isFinite(ms)) return null;
	const shifted = new Date(ms + tzOffsetHours * HOUR_MS);
	const sameDay =
		nowMs !== null &&
		Number.isFinite(nowMs) &&
		isSameUtcDay(shifted, new Date(nowMs + tzOffsetHours * HOUR_MS));
	const stamp = shifted.toLocaleString("en-US", {
		timeZone: "UTC",
		...(sameDay ? {} : { month: "numeric", day: "numeric", year: "numeric" }),
		hour: "numeric",
		minute: "2-digit",
	});
	// en-US separates the date from the time with a comma; the design does not.
	return `${stamp.replace(", ", " ")} ${zoneLabel(tzOffsetHours)}`;
}

/** Same calendar day, comparing the UTC fields of two already-shifted stamps. */
function isSameUtcDay(a: Date, b: Date): boolean {
	return (
		a.getUTCFullYear() === b.getUTCFullYear() &&
		a.getUTCMonth() === b.getUTCMonth() &&
		a.getUTCDate() === b.getUTCDate()
	);
}

/**
 * `68 seconds` — the collapsed player's duration line, spelled out rather than
 * the card's MM:SS. Nothing in this app is long enough for that to get silly,
 * and the design prints seconds.
 */
export function durationSecondsLabel(seconds: number | null): string | null {
	if (seconds === null || !Number.isFinite(seconds)) return null;
	const whole = Math.max(0, Math.round(seconds));
	return `${whole} ${whole === 1 ? "second" : "seconds"}`;
}
