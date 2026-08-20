import type React from "react";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";
import { chipColor, tagGroups, tagLabel, tagsIn } from "./tagPalette";

/**
 * Who and what the recording named without being party to, in four columns,
 * plus every tag it carries.
 *
 * The first three read the structured `mentions` lists, not tags, and that is
 * the whole reason those fields exist: tags.py emits `facility:` for both a
 * participant's own facility and a merely-mentioned one, so a tag cannot tell
 * you whether a facility was on the call or only talked about. Deriving this
 * panel from tags would put every controller's own sector in the list of places
 * they mentioned.
 *
 * The fourth column is the exception. `topics` is a closed 25-value vocabulary
 * already fully represented by the `topic:` namespace, and a topic is only ever
 * what a call is *about* — so there is no conflation to avoid and no separate
 * field to keep in step. It reads tags on purpose.
 *
 * Empty columns are dropped: at 206x39 a heading with nothing under it spends a
 * quarter of the panel saying nothing.
 *
 * The tags section below the four columns is what used to be the Details tab's
 * Tags column (issue #521): that column had no vertical scroll of its own, so
 * a clip with many tags got clipped. This panel already scrolls the way
 * Transcript does (see cardTabs.module.scss's `[data-tab="mentions"]`
 * override), so the same namespace-grouped chips read in full here instead.
 * Same rule as the four columns above — an item with no tags omits the
 * section rather than printing "No tags.", so an untagged clip's Mentions tab
 * never renders a heading with nothing under it.
 */
export const MentionsTab: React.FC<CardTabProps> = ({ meta }) => {
	const mentions = meta?.mentions;
	const columns = [
		{ key: "facilities", label: "Facilities", values: mentions?.facilities },
		{ key: "aircraft", label: "Aircraft", values: mentions?.aircraft },
		{ key: "people", label: "People", values: mentions?.people },
		{ key: "topics", label: "Topics", values: tagsIn(meta?.tags, "topic").map(tagLabel) },
	].filter((column) => (column.values?.length ?? 0) > 0);

	const groups = tagGroups(meta?.tags);

	return (
		<div className={styles.rtTabPanel} data-tab="mentions">
			{columns.length === 0 && groups.length === 0 ? (
				<p className={styles.rtEmpty}>Nothing else named.</p>
			) : (
				<>
					{columns.length > 0 && (
						<div className={styles.rtColumns}>
							{columns.map((column) => (
								<div
									key={column.key}
									className={styles.rtColumn}
									data-column={column.key}
								>
									<h4 className={styles.rtColumnLabel}>{column.label}</h4>
									<ul className={styles.rtColumnList}>
										{column.values?.map((value) => (
											<li key={value} className={styles.rtColumnValue}>
												{value}
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
					)}

					{groups.length > 0 && (
						<section className={styles.rtPanelColumn} data-column="tags">
							<h4 className={styles.rtPanelColumnHead}>Tags</h4>
							<dl className={styles.rtDetailRows}>
								{groups.map((group) => (
									<div
										key={group.key}
										className={styles.rtDetailRow}
										data-tag-group={group.key}
									>
										<dt className={styles.rtDetailLabel}>{group.label}</dt>
										{/* Chips wrap and must not be ellipsised, so this cell is
										    not the single-line .rtDetailValue the text rows use. */}
										<dd className={styles.rtChipCell}>
											<ul className={styles.rtChips} aria-label={group.label}>
												{group.tags.map((tag) => (
													// mp3_tags.color is NULL on every row today, so
													// the namespace palette is the source of truth;
													// color is honoured only if a curator sets one.
													<li
														key={tag.tag}
														className={styles.rtChip}
														style={{ background: chipColor(tag) }}
													>
														{tagLabel(tag)}
													</li>
												))}
											</ul>
										</dd>
									</div>
								))}
							</dl>
						</section>
					)}
				</>
			)}
		</div>
	);
};
