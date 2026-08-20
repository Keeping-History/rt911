import type React from "react";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";
import { durationLabel, itemTiming, wallClockLabel } from "./itemTiming";

/**
 * When the clip ran — the one column Figma drew on the Details tab that
 * survives here. The other two moved out: Summary is a tab of its own
 * (SummaryTab.tsx, story 035), and Tags moved to the Mentions tab (issue
 * #521) — the Tags column had no vertical scroll, so a clip with many tags
 * got clipped, and Mentions already scrolls the way Transcript does.
 *
 * The timings come off the MediaItem, which is why this panel still says
 * something useful for the 59 items that have no metadata: a clip always has
 * a start, whether or not anything transcribed it. The column keeps its
 * heading and prints its own "nothing here" line rather than collapsing, so
 * cards stay aligned across a lane and a reader can tell an untimed clip from
 * a misrendered one.
 *
 * Rows whose value is unknown are still dropped inside the column — an absent
 * End is not a fact about the recording, it is a fact about the row.
 */
export const DetailsTab: React.FC<CardTabProps> = ({ item, meta, tzOffsetHours }) => {
	const timing = itemTiming(item);
	const rows = [
		{ field: "start", label: "Start", value: wallClockLabel(timing.startMs, tzOffsetHours) },
		{ field: "end", label: "End", value: wallClockLabel(timing.endMs, tzOffsetHours) },
		{ field: "duration", label: "Duration", value: durationLabel(timing.durationSec) },
		{ field: "link", label: "Link", value: meta?.link?.trim() || null },
	].filter((row) => row.value !== null);

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
			</div>
		</div>
	);
};
