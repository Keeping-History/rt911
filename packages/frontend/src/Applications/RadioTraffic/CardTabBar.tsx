// The card's tab strip, and the table that defines what the tabs are.
//
// A table rather than a switch, which is the whole reason cardTabProps.ts
// exists: every panel takes the same props, so "which panel is showing" is a
// lookup and adding a tab is one row here rather than a branch in the card, a
// branch in the bar and a label map that can disagree with both.
//
// The bar is the bar only — the card renders the active panel from the same
// table. Keeping the panel out of here is what lets the card own the 207-wide
// tabs region as a whole (bar above panel) instead of nesting one fixed box
// inside another.

import type React from "react";
import { useEffect, useRef } from "react";
import type { ItemMeta } from "../../Providers/MediaStream/MediaStreamContext";
import { useHorizontalOverflow } from "../radio-core/useHorizontalOverflow";
import type { CardTabProps } from "./tabs/cardTabProps";
import { DetailsTab } from "./tabs/DetailsTab";
import { MentionsTab } from "./tabs/MentionsTab";
import { PartiesTab } from "./tabs/PartiesTab";
import { SourceTab } from "./tabs/SourceTab";
import { SummaryTab } from "./tabs/SummaryTab";
import { TranscriptTab } from "./tabs/TranscriptTab";
import styles from "./trafficCard.module.scss";

export interface CardTab {
	/** Matches the panel's own `data-tab`, so the two can't drift apart. */
	id: string;
	label: string;
	Panel: React.FC<CardTabProps>;
	/**
	 * Whether this item has anything for the tab to show. Absent means "always",
	 * which is every tab today: each one prints its own "nothing here" line
	 * rather than disappearing (an untagged clip still has timings, a clip with
	 * no summary still says so — story 049). A tab that removed itself was
	 * indistinguishable from a bug when `subject` came back null for all 814
	 * rows because the backfill that populates it had never run; the fix keeps
	 * this predicate available for a tab that genuinely needs to be gated, but
	 * nothing currently sets it.
	 */
	available?: (meta: ItemMeta | undefined) => boolean;
}

/**
 * The tabs, in the order a listener meets them: what the clip is, what it was
 * about, what is being said, who is saying it, what they name, and where the
 * attribution came from. Details leads because it is the only panel that says
 * something useful for an item with no metadata at all.
 */
export const CARD_TABS: readonly CardTab[] = [
	{ id: "details", label: "Details", Panel: DetailsTab },
	{ id: "summary", label: "Summary", Panel: SummaryTab },
	{ id: "transcript", label: "Transcript", Panel: TranscriptTab },
	{ id: "parties", label: "Parties", Panel: PartiesTab },
	{ id: "mentions", label: "Mentions", Panel: MentionsTab },
	{ id: "source", label: "Source", Panel: SourceTab },
];

/**
 * The tabs one item actually has.
 *
 * Every tab is available on every card today (story 049) — a tab that hides
 * itself when its data is empty is indistinguishable from a bug, which is
 * exactly what happened to Summary while `subject` sat null on all 814 rows.
 * The filter stays rather than being inlined as `CARD_TABS` directly: a tab
 * that genuinely depends on the item (not merely on data an empty state can
 * speak to) still has a seam to gate through via `available`, and the bar's
 * own overflow measurement (`useHorizontalOverflow`) measures the rendered
 * strip's actual width, not the tab count, so it stays correct either way.
 */
export function visibleCardTabs(meta: ItemMeta | undefined): readonly CardTab[] {
	return CARD_TABS.filter((tab) => tab.available?.(meta) ?? true);
}

interface CardTabBarProps {
	tabs: readonly CardTab[];
	active: string;
	onSelect: (id: string) => void;
}

/**
 * Fully controlled, like ToolPalette: it renders the active tab and reports
 * picks. "Exactly one tab is selected" is then a property of the single
 * `active` prop rather than something six buttons have to keep agreeing about.
 *
 * The labels do not all fit in 207px, so the arrows are not decoration — they
 * are how the last tabs are reachable at all. Whether they are *needed* is
 * measured, not assumed: radio-core's useHorizontalOverflow already answers
 * exactly this question for the tuner's segment list, and a card in a wide
 * lane (Step 18 resizes them) may well fit all six.
 */
export const CardTabBar: React.FC<CardTabBarProps> = ({ tabs, active, onSelect }) => {
	const { containerRef, contentRef, overflowing } = useHorizontalOverflow();
	const activeRef = useRef<HTMLButtonElement | null>(null);
	const index = tabs.findIndex((tab) => tab.id === active);

	useEffect(() => {
		const el = activeRef.current;
		// Paging that selects a tab without bringing it into view is paging into a
		// hidden panel label, so the strip follows the selection. jsdom implements
		// no scrolling at all and leaves scrollIntoView undefined, hence the
		// feature test rather than an optional call.
		if (!overflowing || typeof el?.scrollIntoView !== "function") return;
		el.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [overflowing, active]);

	const page = (step: number) => {
		const next = tabs[index + step];
		if (next) onSelect(next.id);
	};

	return (
		<div className={styles.rtCardTabBar}>
			{overflowing && (
				<button
					type="button"
					className={styles.rtCardTabArrow}
					aria-label="Previous tab"
					title="Previous tab"
					disabled={index <= 0}
					onClick={() => page(-1)}
				>
					<span aria-hidden="true">‹</span>
				</button>
			)}
			<div className={styles.rtCardTabViewport} data-tab-viewport ref={containerRef}>
				<div
					className={styles.rtCardTabStrip}
					role="tablist"
					aria-label="Clip details"
					ref={contentRef}
				>
					{tabs.map((tab) => {
						const selected = tab.id === active;
						return (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={selected}
								className={
									selected ? `${styles.rtCardTab} ${styles.rtCardTabSelected}` : styles.rtCardTab
								}
								ref={selected ? activeRef : undefined}
								onClick={() => onSelect(tab.id)}
							>
								{tab.label}
							</button>
						);
					})}
				</div>
			</div>
			{overflowing && (
				<button
					type="button"
					className={styles.rtCardTabArrow}
					aria-label="Next tab"
					title="Next tab"
					disabled={index >= tabs.length - 1}
					onClick={() => page(1)}
				>
					<span aria-hidden="true">›</span>
				</button>
			)}
		</div>
	);
};
