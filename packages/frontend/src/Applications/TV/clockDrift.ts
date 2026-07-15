import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

/**
 * The virtual clock's `dateTime` (from `useClassicyDateTime()`) is the raw
 * Zustand store value, only updated on minute boundaries — not a live tick.
 * Any "now" derived straight from it can be up to just-under-a-minute stale.
 * Compensate by adding real wall-clock time elapsed since it last changed.
 */
export function resolveVirtualNowMs(
	storeDateTime: string,
	dateTimeUpdatedAtMs: number,
	realNowMs: number,
): number {
	const elapsedRealMs = realNowMs - dateTimeUpdatedAtMs;
	return new Date(storeDateTime).getTime() + elapsedRealMs;
}

/** Seconds into the media file that corresponds to the given wall-clock time. */
export function calcSeekSeconds(
	item: Pick<MediaItem, "start_date" | "jump">,
	clockMs: number,
): number {
	// Directus stores datetimes without a timezone suffix; force UTC so that
	// JavaScript does not misinterpret them as local time.
	const dateStr = /Z$|[+-]\d{2}:\d{2}$/.test(item.start_date)
		? item.start_date
		: item.start_date + "Z";
	const startMs = new Date(dateStr).getTime();
	const raw = (clockMs - startMs) / 1000 + item.jump;
	// Do not cap by calc_duration — it may be inaccurate for archive streams.
	// Let the player handle out-of-bounds positions natively.
	return Math.max(0, raw);
}
