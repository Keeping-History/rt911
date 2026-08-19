import type React from "react";
import type { ItemMeta } from "../../../Providers/MediaStream/MediaStreamContext";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";

/**
 * What the clip was about, in the derivation's own words.
 *
 * A tab of its own rather than Details' third column: `subject` is prose of no
 * fixed length and it was the tallest thing on the Details panel, which is what
 * made a shared, fixed panel height unworkable while it lived there (story 033
 * fixes every panel to one height; this is what lets it).
 *
 * The card only offers this tab for an item that has a summary — see
 * `visibleCardTabs` in CardTabBar.tsx — so the empty line below is the panel
 * keeping the house rule that no tab ever paints an empty box, not a state the
 * listener is routinely shown.
 */

/**
 * The item's summary prose, or undefined when it has none.
 *
 * Exported because "is there a summary" is asked twice — once to decide whether
 * the tab exists at all, once to paint it — and two answers to that question are
 * free to disagree.
 */
export function summaryText(meta: ItemMeta | undefined): string | undefined {
	return meta?.subject?.trim() || undefined;
}

export const SummaryTab: React.FC<CardTabProps> = ({ meta }) => {
	const subject = summaryText(meta);

	return (
		<div className={styles.rtTabPanel} data-tab="summary">
			{/* The same boxed column the Details panel draws, so a listener paging
			    between the two reads one panel style rather than two. */}
			<div className={styles.rtPanelColumns}>
				<section className={styles.rtPanelColumn} data-column="summary">
					<h4 className={styles.rtPanelColumnHead}>Summary</h4>
					{subject ? (
						<p className={styles.rtSubject} data-field="subject">
							{subject}
						</p>
					) : (
						<p className={styles.rtEmpty}>No summary.</p>
					)}
				</section>
			</div>
		</div>
	);
};
