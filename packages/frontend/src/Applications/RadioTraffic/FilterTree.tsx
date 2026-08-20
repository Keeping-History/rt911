/**
 * The filter sidebar: one row per tag namespace, and the only navigation Radio
 * Traffic has.
 *
 * Fully controlled. The tree owns no checked state — it renders the set it is
 * handed and reports the tag a click landed on, so the app shell (Step 19) is
 * the single place a filter can change. A tree that kept its own copy would
 * have to be reconciled with the picker's, which is handed the same whole set
 * for exactly this reason.
 */
import { ClassicyBevelButton, ClassicyCheckbox } from "classicy";
import type React from "react";
import { Disclosure } from "../../Components/Disclosure/Disclosure";
import styles from "./filterTree.module.scss";
import type { TagGroup } from "./tagFilter";

/**
 * The namespaces the sidebar boots expanded.
 *
 * The tree has ~555px below the toolbar in a 601px window. Eight headers plus
 * these four namespaces' 18 values (tier 2, link 5, agency 5, role 6) fit
 * without scrolling; `topic`'s 25 values on their own would more than double
 * that, so it opens on request. The three large namespaces are absent because
 * they have no disclosure to open.
 *
 * `defaultOpen` is why this uses the repo-local Disclosure rather than
 * `ClassicyDisclosure`, which always boots closed — with it the sidebar would
 * open as eight dead headers hiding every checkbox.
 */
export const OPEN_BY_DEFAULT: ReadonlySet<string> = new Set([
	"tier",
	"link",
	"agency",
	"role",
]);

export interface FilterTreeProps {
	/** Every namespace, in the order the vocabulary arrived in. */
	groups: TagGroup[];
	/** The whole sidebar's checked tag strings, large namespaces included. */
	checked: ReadonlySet<string>;
	/** A value's box was clicked; the owner adds or removes the tag. */
	onToggle: (tag: string) => void;
	/** A large namespace's row was clicked; the owner opens that picker. */
	onOpenPicker: (namespace: string) => void;
	/**
	 * The vocabulary is the last-known-good copy because `GET /mp3/tags` failed.
	 * The tree still renders it — see the notice below.
	 */
	stale?: boolean;
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
 * namespace is the resting state, not a fact worth printing eight times.
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

export const FilterTree: React.FC<FilterTreeProps> = ({
	groups,
	checked,
	onToggle,
	onOpenPicker,
	stale = false,
}) => {
	// A namespace with no values is a dead end in both shapes: nothing to tick
	// inline, and a picker that would open on an empty list.
	const shown = groups.filter((group) => group.values.length > 0);

	// Decision 5: tag filtering IS the navigation here, so a failed vocabulary
	// fetch degrades to the last-known-good copy plus a note, never to a blank
	// column. Only a vocabulary that never loaded at all leaves nothing to show,
	// and that says so rather than rendering 141px of nothing.
	const notice =
		shown.length === 0
			? "Tags unavailable."
			: stale
				? "Tags may be out of date."
				: null;

	return (
		<div className={styles.rtFilterTree} role="group" aria-label="Tag filters">
			{notice && (
				<p className={styles.rtFilterNotice} role="status">
					{notice}
				</p>
			)}
			{shown.map((group) =>
				group.large ? (
					<LargeNamespaceRow
						key={group.namespace}
						group={group}
						count={checkedIn(group, checked)}
						onOpen={onOpenPicker}
					/>
				) : (
					<Disclosure
						key={group.namespace}
						label={group.label}
						defaultOpen={OPEN_BY_DEFAULT.has(group.namespace)}
					>
						{group.values.map((tag) => (
							<ClassicyCheckbox
								key={tag.tag}
								// Prefixed like the picker's ids: a bare `topic:hijack` as a
								// DOM id would let a label in one address a box in the other.
								id={`rt_filter_${tag.tag}`}
								label={tag.value ?? tag.tag}
								checked={checked.has(tag.tag)}
								onClickFunc={() => onToggle(tag.tag)}
							/>
						))}
					</Disclosure>
				),
			)}
		</div>
	);
};
