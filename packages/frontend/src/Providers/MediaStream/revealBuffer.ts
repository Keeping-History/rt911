// Reveal-gate helpers for look-ahead windowing.
//
// The server sends a forward *window* of items in one frame (see Phase 2 windowing
// in the backend), rather than one item per virtual second. The client must NOT
// surface those items immediately — that would dump a whole window at once and
// break the deliberately forward-only pager pacing. Instead, future items wait in
// a buffer and are revealed only as the virtual clock reaches each item's
// start_date. These pure helpers are that gate; the provider owns the buffers and
// the live state, and calls these on each frame and each clock tick.

// An "id'd, time-stamped" item — both MediaItem and PagerItem satisfy this.
interface Timed {
	id: number;
	start_date: string;
}

// partitionByDue splits a freshly-received window into items already due at `now`
// (start_date <= now → surface immediately) and items still in the future (hold in
// the buffer until their start_date arrives).
export function partitionByDue<T extends Timed>(
	incoming: T[],
	now: number,
): { due: T[]; future: T[] } {
	const due: T[] = [];
	const future: T[] = [];
	for (const item of incoming) {
		if (new Date(item.start_date).getTime() <= now) due.push(item);
		else future.push(item);
	}
	return { due, future };
}

// drainDue removes and returns every buffered entry whose start_date has been
// reached by `now`, mutating the buffer in place. This is the per-tick reveal:
// it re-imposes virtual-clock pacing on items the server sent ahead in bulk.
// Order of receipt is irrelevant — entries are keyed by id and promoted by time.
export function drainDue<T extends Timed>(buffer: Map<number, T>, now: number): T[] {
	const due: T[] = [];
	for (const [id, item] of buffer) {
		if (new Date(item.start_date).getTime() <= now) {
			due.push(item);
			buffer.delete(id);
		}
	}
	return due;
}
