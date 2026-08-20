/**
 * The filter sidebar: one disclosure per small tag namespace, part of Radio
 * Traffic's only navigation alongside the large-namespace buttons rendered
 * above it (`LargeNamespaceButtons`).
 *
 * Fully controlled. The tree owns no checked state — it renders the set it is
 * handed and reports the tag a click landed on, so the app shell (Step 19) is
 * the single place a filter can change. A tree that kept its own copy would
 * have to be reconciled with the picker's, which is handed the same whole set
 * for exactly this reason.
 */
import { ClassicyCheckbox } from "classicy";
import type React from "react";
import { Disclosure } from "../../Components/Disclosure/Disclosure";
import styles from "./filterTree.module.scss";
import type { TagGroup } from "./tagFilter";

/**
 * The namespaces the tree boots expanded.
 *
 * The tree has ~555px below the toolbar and the large-namespace buttons in a
 * 601px window. Five headers plus these four namespaces' 18 values (tier 2,
 * link 5, agency 5, role 6) fit without scrolling; `topic`'s 25 values on
 * their own would more than double that, so it opens on request.
 *
 * `defaultOpen` is why this uses the repo-local Disclosure rather than
 * `ClassicyDisclosure`, which always boots closed — with it the tree would
 * open as five dead headers hiding every checkbox.
 */
export const OPEN_BY_DEFAULT: ReadonlySet<string> = new Set([
	"tier",
	"link",
	"agency",
	"role",
]);

export interface FilterTreeProps {
	/** The five small, disclosure-based namespaces, in the order they arrived. */
	groups: TagGroup[];
	/** The whole sidebar's checked tag strings, large namespaces included. */
	checked: ReadonlySet<string>;
	/** A value's box was clicked; the owner adds or removes the tag. */
	onToggle: (tag: string) => void;
	/**
	 * The vocabulary is the last-known-good copy because `GET /mp3/tags` failed.
	 * The tree still renders it — see the notice below.
	 */
	stale?: boolean;
}

export const FilterTree: React.FC<FilterTreeProps> = ({
	groups,
	checked,
	onToggle,
	stale = false,
}) => {
	// A namespace with no values is a dead end: nothing to tick inline.
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
			{shown.map((group) => (
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
			))}
		</div>
	);
};
