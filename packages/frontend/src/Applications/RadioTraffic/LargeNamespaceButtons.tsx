/**
 * The three large-namespace "doors" (Aircraft, Facility, Person) — a small,
 * non-scrolling stack that sits above `FilterTree`, not inside it.
 *
 * Fully controlled, same as `FilterTree`: it owns no checked state, just
 * renders the set it is handed and reports which picker a click asked for.
 */
import { ClassicyBevelButton } from "classicy";
import type React from "react";
import styles from "./largeNamespaceButtons.module.scss";
import type { TagGroup } from "./tagFilter";

export interface LargeNamespaceButtonsProps {
	/** The large namespaces only — the caller filters `groups` by `.large`. */
	groups: TagGroup[];
	/** The whole sidebar's checked tag strings, small namespaces included. */
	checked: ReadonlySet<string>;
	/** A row was clicked; the owner opens that namespace's picker. */
	onOpenPicker: (namespace: string) => void;
}

/**
 * How many of a namespace's values are checked.
 *
 * Counted against the namespace's own values rather than by prefix-matching the
 * checked set: a checked tag the vocabulary no longer carries has no box in the
 * picker either, so counting it would advertise a filter the user cannot reach
 * to clear.
 */
function checkedIn(group: TagGroup, checked: ReadonlySet<string>): number {
	let n = 0;
	for (const tag of group.values) if (checked.has(tag.tag)) n += 1;
	return n;
}

/**
 * A large namespace's row. 377 aircraft cannot expand into a 141px column, so
 * the row is a door to the picker and the checked count is the only state it
 * can show. Zero reads as no count at all rather than "(0)" — an unfiltered
 * namespace is the resting state, not a fact worth printing three times.
 */
const LargeNamespaceRow: React.FC<{
	group: TagGroup;
	count: number;
	onOpen: (namespace: string) => void;
}> = ({ group, count, onOpen }) => (
	<ClassicyBevelButton data-filter-large-row onClickFunc={() => onOpen(group.namespace)}>
		<span>{group.label}…</span>
		{count > 0 && <span className={styles.rtFilterCount}>({count})</span>}
	</ClassicyBevelButton>
);

export const LargeNamespaceButtons: React.FC<LargeNamespaceButtonsProps> = ({
	groups,
	checked,
	onOpenPicker,
}) => {
	// A namespace with no values is a dead end: a picker that would open on an
	// empty list, same reasoning `FilterTree` applies to the small namespaces.
	const shown = groups.filter((group) => group.values.length > 0);

	// Nothing to show and nothing to say about it — the "Tags unavailable"
	// notice belongs to `FilterTree` alone, so an empty large-namespace set
	// renders as a plain absence rather than a second notice.
	if (shown.length === 0) return null;

	return (
		<div className={styles.rtLargeNamespaceButtons} role="group" aria-label="Tag pickers">
			{shown.map((group) => (
				<LargeNamespaceRow
					key={group.namespace}
					group={group}
					count={checkedIn(group, checked)}
					onOpen={onOpenPicker}
				/>
			))}
		</div>
	);
};
