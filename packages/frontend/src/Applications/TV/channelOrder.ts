import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

/**
 * Channel ordering for the TV thumbnail strip.
 *
 * Ordering is keyed on `item.source` (the channel slug), never `item.id`:
 * ids belong to the currently-airing MediaItem and change every time the
 * virtual clock rolls into a new program, which would silently scramble a
 * saved order keyed on them.
 */

/**
 * Apply the user's saved order, appending anything unsaved.
 *
 * Saved channels come first in `channelOrder`'s sequence; every other item
 * follows in its **incoming relative order**. That's the precedence rule: the
 * user's arrangement wins, and the underlying order — today WebSocket arrival
 * order, tomorrow whatever server-side ordering exists — supplies the default
 * for channels the user has never dragged.
 */
export function orderChannels(items: MediaItem[], channelOrder: string[]): MediaItem[] {
	if (channelOrder.length === 0) return items;

	const bySource = new Map<string, MediaItem>();
	for (const item of items) {
		if (item.source) bySource.set(item.source, item);
	}

	const saved: MediaItem[] = [];
	const seen = new Set<string>();
	for (const source of channelOrder) {
		const item = bySource.get(source);
		// A saved slug with no item (channel disabled, or not yet streamed in)
		// is skipped rather than leaving a hole.
		if (item && !seen.has(source)) {
			saved.push(item);
			seen.add(source);
		}
	}

	const rest = items.filter((item) => !item.source || !seen.has(item.source));
	return [...saved, ...rest];
}

/**
 * Move `from` to the position it was dropped on, returning a new slug array.
 *
 * The dragged channel takes the target's slot: dragging forward lands it
 * *after* the target, dragging backward lands it *before*. Always inserting
 * before the target would make a forward drag appear to stop one slot short of
 * where the user dropped it.
 *
 * `visibleOrder` is the strip's current on-screen order. When `from` isn't in
 * `order` yet — the common case, since the saved order starts empty — we
 * materialize `visibleOrder` first. Without that, the first drag would produce
 * a one-element array and send every other channel to the end.
 */
export function moveChannel(
	order: string[],
	visibleOrder: string[],
	from: string,
	to: string,
): string[] {
	if (from === to) return order;

	const base = order.includes(from) && order.includes(to) ? [...order] : [...visibleOrder];
	const fromIndex = base.indexOf(from);
	const toIndex = base.indexOf(to);
	if (fromIndex === -1 || toIndex === -1) return order;

	const forward = fromIndex < toIndex;
	base.splice(fromIndex, 1);
	// Recompute the target's index after removal, then land on its slot.
	base.splice(base.indexOf(to) + (forward ? 1 : 0), 0, from);
	return base;
}
