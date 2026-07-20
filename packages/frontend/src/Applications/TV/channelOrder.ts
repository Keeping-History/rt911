// Pure ordering/geometry helpers for the TV thumbnail strip's drag-to-reorder.
// Kept free of React/DOM so they can be unit-tested directly.

/**
 * Sort items by a saved channel order (list of `source` slugs). Sources not in
 * the saved order append after the ordered ones in their input order, so new
 * channels (and the empty first-run order) render exactly as the wire delivers
 * them.
 */
export function sortByChannelOrder<T extends { source?: string }>(
	items: T[],
	order: string[],
): T[] {
	if (order.length === 0) return items;
	const rank = new Map(order.map((source, i) => [source, i]));
	// Stable: equal ranks (both unknown → Infinity) keep input order.
	return [...items].sort(
		(a, b) =>
			(rank.get(a.source ?? "") ?? Infinity) -
			(rank.get(b.source ?? "") ?? Infinity),
	);
}

/**
 * The insertion index for a pointer at `pointerX`, given the thumbnails'
 * rects in display order (any shared coordinate space): the number of
 * thumbnail midpoints left of the pointer. 0 = before the first thumbnail,
 * rects.length = after the last.
 */
export function insertionIndexFromX(
	rects: Array<{ left: number; width: number }>,
	pointerX: number,
): number {
	let index = 0;
	for (const rect of rects) {
		if (pointerX > rect.left + rect.width / 2) index++;
	}
	return index;
}

/**
 * Move `sources[fromIndex]` to insertion index `toIndex` (0..sources.length,
 * measured before removal). Returns the input array unchanged (same reference)
 * when the drop wouldn't move anything, so callers can skip persisting.
 */
export function applyReorder(
	sources: string[],
	fromIndex: number,
	toIndex: number,
): string[] {
	// Dropping into its own slot or the gap just after itself is a no-op.
	if (toIndex === fromIndex || toIndex === fromIndex + 1) return sources;
	const next = [...sources];
	const [moved] = next.splice(fromIndex, 1);
	// Removal shifted everything after fromIndex left by one.
	next.splice(toIndex > fromIndex ? toIndex - 1 : toIndex, 0, moved);
	return next;
}
