import type React from "react";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";
import { tagLabel, tagsIn } from "./tagPalette";

/**
 * Who and what the recording named without being party to, in four columns.
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
 */
export const MentionsTab: React.FC<CardTabProps> = ({ meta }) => {
	const mentions = meta?.mentions;
	const columns = [
		{ key: "facilities", label: "Facilities", values: mentions?.facilities },
		{ key: "aircraft", label: "Aircraft", values: mentions?.aircraft },
		{ key: "people", label: "People", values: mentions?.people },
		{ key: "topics", label: "Topics", values: tagsIn(meta?.tags, "topic").map(tagLabel) },
	].filter((column) => (column.values?.length ?? 0) > 0);

	return (
		<div className={styles.rtTabPanel} data-tab="mentions">
			{columns.length === 0 ? (
				<p className={styles.rtEmpty}>Nothing else named.</p>
			) : (
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
		</div>
	);
};
