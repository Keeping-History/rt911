// bookmarkTime.ts
// Pure helpers converting between the Time Machine's 12-hour local time form
// and the bare-UTC wall-clock strings tm_bookmarks(_personal) store. Mirrors
// the UTC conventions in setVirtualClock.ts (which owns the clock writer); kept
// separate so the form's parts<->UTC math is unit-testable in isolation.

export interface LocalTimeParts {
	hours: string;
	minutes: string;
	seconds: string;
	ampm: string;
}

const HAS_ZONE = /[zZ]$|[+-]\d\d:?\d\d$/;

export function parseDirectusUtc(s: string): Date {
	const trimmed = s.trim();
	const date = new Date(HAS_ZONE.test(trimmed) ? trimmed : `${trimmed}Z`);
	if (Number.isNaN(date.getTime())) throw new Error(`Unparseable UTC date string: "${s}"`);
	return date;
}

export function toDirectusUtcString(d: Date): string {
	return d.toISOString().slice(0, 19); // drop ".sssZ"
}

export function utcToLocalParts(utc: Date, tzOffsetHours: number): LocalTimeParts {
	const local = new Date(utc.getTime() + tzOffsetHours * 3_600_000);
	let h = local.getUTCHours();
	const ampm = h >= 12 ? "PM" : "AM";
	h = h % 12 || 12;
	return {
		hours: String(h),
		minutes: String(local.getUTCMinutes()).padStart(2, "0"),
		seconds: String(local.getUTCSeconds()).padStart(2, "0"),
		ampm,
	};
}

export function localPartsToUtcDate(
	baseUtc: Date,
	parts: LocalTimeParts,
	tzOffsetHours: number,
): Date {
	const localH24 = (parseInt(parts.hours, 10) % 12) + (parts.ampm === "PM" ? 12 : 0);
	const utcH = localH24 - tzOffsetHours; // setUTCHours wraps out-of-range values
	const d = new Date(baseUtc);
	d.setUTCHours(utcH, parseInt(parts.minutes, 10), parseInt(parts.seconds, 10), 0);
	return d;
}
