// Retention predicates for time-pruned stream channels.
//
// The look-ahead window model (see revealBuffer.ts) surfaces an item once the
// virtual clock reaches its start_date, and these predicates decide when a
// surfaced item should be dropped again. They are applied on every clock tick
// and to every freshly-received frame, and are the single source of truth for
// what is "live" on the time-pruned channels (media, mp3, news, pager) — unlike
// usenet, which is never time-pruned and is cleared explicitly on seek.
//
// CRITICAL: the predicate must be correct regardless of which way the clock
// moved. Forward ticking only ever needs the trailing edge (has the item
// ended?), because a surfaced item always started in the past. A *backward*
// seek (rewinding via the Control app) can leave an item in live state whose
// start_date is now in the future — that item is no longer live and must be
// dropped (it will be re-revealed from the buffer when the clock reaches its
// start again). Both predicates therefore guard the leading edge first.

import type { MediaItem, PagerItem } from "./MediaStreamContext";

// Instant items (start_date = end_date or calc_duration = 0) are kept for this
// many milliseconds after their start time before being pruned.
export const INSTANT_RETENTION_MS = 10 * 60 * 1000; // 10 minutes

// Whether a media-shaped item should still be retained at wall time `now`.
// Long items live from their start until their end_date passes; instant items
// linger for INSTANT_RETENTION_MS after their start. Shared by media `items`,
// `mp3Items`, and `newsItems`.
export function keepMediaItem(item: MediaItem, now: number): boolean {
	// Leading edge: not yet started at `now` (e.g. after a backward seek) → not
	// live. Drop it so the reveal buffer can surface it again at its start_date.
	if (new Date(item.start_date).getTime() > now) return false;
	if (!item.end_date) return true;
	const endMs = new Date(item.end_date).getTime();
	if (item.start_date === item.end_date || (item.calc_duration ?? -1) === 0) {
		return now - endMs < INSTANT_RETENTION_MS;
	}
	return endMs > now;
}

// Pager items are always instant — retained by start_date within the instant
// window, and only once the clock has actually reached their start.
export function keepPagerItem(item: PagerItem, now: number): boolean {
	const startMs = new Date(item.start_date).getTime();
	// Leading edge: a pager whose start is still in the future (after a rewind)
	// is not live; without this guard `now - startMs` is negative and passes.
	if (startMs > now) return false;
	return now - startMs < INSTANT_RETENTION_MS;
}
