// Helpers for driving the Classicy virtual clock from UTC date strings.
//
// The clock's canonical value is a UTC instant (see the frontend CLAUDE.md —
// `state.System.Manager.DateAndTime.dateTime`). Only the Time Machine app is
// allowed to mutate it, so these helpers take the `setDateTime` callback from
// `useClassicyDateTime` rather than reaching for the clock themselves — the
// single-writer invariant stays intact.

// Directus stores datetimes without a timezone suffix (e.g.
// "2001-09-11T12:46:40"); such a value is a bare UTC wall-clock time, so we
// append "Z" to parse it as UTC. Strings that already carry a zone designator
// ("Z" or "±hh:mm") are used as-is.
const HAS_ZONE = /[zZ]$|[+-]\d\d:?\d\d$/;

function parseUtc(utc: string): Date {
	const trimmed = utc.trim();
	const date = new Date(HAS_ZONE.test(trimmed) ? trimmed : `${trimmed}Z`);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Unparseable UTC date string: "${utc}"`);
	}
	return date;
}

/**
 * Set the Classicy virtual clock from a UTC date string.
 *
 * Returns the parsed Date so callers can log/track the exact instant applied.
 * Throws on an unparseable string rather than silently seeking to Invalid Date.
 */
export function setDateTimeFromUtc(setDateTime: (date: Date) => void, utc: string): Date {
	const date = parseUtc(utc);
	setDateTime(date);
	return date;
}

/**
 * Format a UTC date string as a 12-hour local wall-clock time (e.g.
 * "8:46:40 AM"), shifting by the Classicy timezone offset in hours — the same
 * display space the menu-bar clock and the Time Machine time-entry form use.
 */
export function formatUtcAsLocalTime(utc: string, tzOffsetHours: number): string {
	const local = new Date(parseUtc(utc).getTime() + tzOffsetHours * 3_600_000);
	let hours = local.getUTCHours();
	const ampm = hours >= 12 ? "PM" : "AM";
	hours = hours % 12 || 12;
	const minutes = String(local.getUTCMinutes()).padStart(2, "0");
	const seconds = String(local.getUTCSeconds()).padStart(2, "0");
	return `${hours}:${minutes}:${seconds} ${ampm}`;
}
