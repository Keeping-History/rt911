import type { ReactNode } from "react";
import "./HyperCardPartGrid.css";

/**
 * Shared grid layout for a Directus*Part rendering more than one embedded
 * item (issue #560 — TV Video's `channelId`, Weather Station's `station` and
 * Flight Map's `flight` all widened from a single scalar to an array). Mirrors
 * `DirectusMultiviewPart.tsx`'s own "video wall" grid — that component is the
 * template this generalizes, since it already rendered an array of tiles end
 * to end before this issue.
 */

/** Balanced column count for `n` tiles when the author doesn't set one. */
export function autoGridColumns(n: number): number {
	return n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
}

export interface HyperCardPartGridProps<T> {
	items: readonly T[];
	renderItem: (item: T, index: number) => ReactNode;
	getKey: (item: T, index: number) => string | number;
	columns?: number;
	/** Extra class(es) appended to the grid container, e.g. to inherit a part's own background. */
	className?: string;
}

export function HyperCardPartGrid<T>({ items, renderItem, getKey, columns, className }: HyperCardPartGridProps<T>) {
	const cols = Math.min(columns ?? autoGridColumns(items.length), items.length || 1);
	return (
		<div
			className={["classicyHyperCardPartGrid", className].filter(Boolean).join(" ")}
			style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
		>
			{items.map((item, i) => (
				<div key={getKey(item, i)} className="classicyHyperCardPartGridTile">
					{renderItem(item, i)}
				</div>
			))}
		</div>
	);
}
