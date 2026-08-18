import type React from "react";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";
import { durationLabel, itemTiming, wallClockLabel } from "./itemTiming";
import { chipColor, tagLabel } from "./tagPalette";

/**
 * When the clip ran, what net it ran on, what it was about, and how it is
 * tagged — the tab a listener lands on.
 *
 * The timings come off the MediaItem and the rest off ItemMeta, which is why
 * this panel still says something useful for the 59 items that have no
 * metadata: a clip always has a start, whether or not anything transcribed it.
 *
 * Rows whose value is unknown are dropped rather than printed with a dash. At
 * 206x39 an em dash costs a line that a real value could have used, and an
 * absent End is not a fact about the recording — it is a fact about the row.
 */
export const DetailsTab: React.FC<CardTabProps> = ({ item, meta, tzOffsetHours }) => {
	const timing = itemTiming(item);
	const rows = [
		{ field: "start", label: "Start", value: wallClockLabel(timing.startMs, tzOffsetHours) },
		{ field: "end", label: "End", value: wallClockLabel(timing.endMs, tzOffsetHours) },
		{ field: "duration", label: "Duration", value: durationLabel(timing.durationSec) },
		{ field: "link", label: "Link", value: meta?.link?.trim() || null },
	].filter((row) => row.value !== null);

	const subject = meta?.subject?.trim();
	const tags = meta?.tags ?? [];

	return (
		<div className={styles.rtTabPanel} data-tab="details">
			<dl className={styles.rtDetailRows}>
				{rows.map((row) => (
					<div key={row.field} className={styles.rtDetailRow} data-field={row.field}>
						<dt className={styles.rtDetailLabel}>{row.label}</dt>
						<dd className={styles.rtDetailValue}>{row.value}</dd>
					</div>
				))}
			</dl>
			{subject ? (
				<p className={styles.rtSubject} data-field="subject">
					{subject}
				</p>
			) : null}
			{tags.length > 0 ? (
				<ul className={styles.rtChips} aria-label="Tags">
					{tags.map((tag) => (
						// mp3_tags.color is NULL on every row today, so the namespace
						// palette is the source of truth; color is honoured only if a
						// curator ever sets one.
						<li
							key={tag.tag}
							className={styles.rtChip}
							style={{ background: chipColor(tag) }}
						>
							{tagLabel(tag)}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
};
