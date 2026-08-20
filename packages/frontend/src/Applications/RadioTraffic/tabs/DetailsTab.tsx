import type React from "react";
import type { TagDef } from "../../../Providers/MediaStream/MediaStreamContext";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";
import { durationLabel, itemTiming, wallClockLabel } from "./itemTiming";
import { chipColor, namespaceLabel, tagLabel, TAG_NAMESPACES } from "./tagPalette";

/**
 * When the clip ran and how it is tagged — two of the three columns Figma drew
 * on the Details tab. The third, Summary, is a tab of its own (SummaryTab.tsx):
 * `subject` is prose of no fixed length and it was what made this panel's height
 * unpredictable, which a shared fixed panel height cannot afford.
 *
 * The timings come off the MediaItem and the tags off ItemMeta, which is why
 * this panel still says something useful for the 59 items that have no
 * metadata: a clip always has a start, whether or not anything transcribed it.
 * Each column keeps its heading and prints its own "nothing here" line rather
 * than collapsing, so the columns stay aligned across cards and a reader can
 * tell an untagged clip from a misrendered one.
 *
 * Rows whose value is unknown are still dropped inside a column — an absent End
 * is not a fact about the recording, it is a fact about the row.
 */

/** One labelled row of chips: a namespace and the tags that belong to it. */
interface TagGroup {
	key: string;
	label: string;
	tags: TagDef[];
}

/**
 * The tags grouped into the rows the design shows, in vocabulary order.
 *
 * A tag whose namespace is outside the eight tags.py emits is collected into a
 * trailing "Other" row rather than dropped: mp3_tags.namespace is NOT NULL, so
 * a ninth value means a curator added a namespace, and silently hiding their
 * tag would look identical to the tag not existing.
 */
function tagGroups(tags: readonly TagDef[] | undefined): TagGroup[] {
	const all = tags ?? [];
	const known = new Set<string>(TAG_NAMESPACES);
	const groups: TagGroup[] = TAG_NAMESPACES.map((namespace) => ({
		key: namespace,
		label: namespaceLabel(namespace),
		tags: all.filter((tag) => tag.namespace === namespace),
	})).filter((group) => group.tags.length > 0);

	const other = all.filter((tag) => !tag.namespace || !known.has(tag.namespace));
	if (other.length > 0) groups.push({ key: "other", label: "Other", tags: other });
	return groups;
}

export const DetailsTab: React.FC<CardTabProps> = ({ item, meta, tzOffsetHours }) => {
	const timing = itemTiming(item);
	const rows = [
		{ field: "start", label: "Start", value: wallClockLabel(timing.startMs, tzOffsetHours) },
		{ field: "end", label: "End", value: wallClockLabel(timing.endMs, tzOffsetHours) },
		{ field: "duration", label: "Duration", value: durationLabel(timing.durationSec) },
		{ field: "link", label: "Link", value: meta?.link?.trim() || null },
	].filter((row) => row.value !== null);

	const groups = tagGroups(meta?.tags);

	return (
		<div className={styles.rtTabPanel} data-tab="details">
			<div className={styles.rtPanelColumns}>
				<section className={styles.rtPanelColumn} data-column="call-details">
					<h4 className={styles.rtPanelColumnHead}>Details</h4>
					{rows.length === 0 ? (
						<p className={styles.rtEmpty}>No timings.</p>
					) : (
						<dl className={styles.rtDetailRows}>
							{rows.map((row) => (
								<div
									key={row.field}
									className={styles.rtDetailRow}
									data-field={row.field}
								>
									<dt className={styles.rtDetailLabel}>{row.label}</dt>
									<dd className={styles.rtDetailValue}>{row.value}</dd>
								</div>
							))}
						</dl>
					)}
				</section>

				<section className={styles.rtPanelColumn} data-column="tags">
					<h4 className={styles.rtPanelColumnHead}>Tags</h4>
					{groups.length === 0 ? (
						<p className={styles.rtEmpty}>No tags.</p>
					) : (
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
					)}
				</section>
			</div>
		</div>
	);
};
