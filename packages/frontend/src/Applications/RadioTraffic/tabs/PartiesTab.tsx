import type React from "react";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";

/** The graded levels; anything else the derivation writes is shown as "other". */
const CONFIDENCE_CLASS: Record<string, string> = {
	high: styles.rtConfHigh,
	medium: styles.rtConfMedium,
	low: styles.rtConfLow,
};

/**
 * The badge for one participant's confidence, or null when ungraded.
 *
 * An unrecognised grade keeps its own text rather than being dropped: the
 * derivation is a model's output and a level this list has not seen is still
 * information about how much to trust the attribution — silently discarding it
 * would make an uncertain party read exactly like a certain one.
 */
function confidenceBadge(
	confidence: string | undefined,
): { level: string; text: string; className: string } | null {
	const text = confidence?.trim();
	if (!text) return null;
	const level = text.toLowerCase();
	const className = CONFIDENCE_CLASS[level];
	return className
		? { level, text: level, className: `${styles.rtConfBadge} ${className}` }
		: { level: "other", text, className: `${styles.rtConfBadge} ${styles.rtConfOther}` };
}

/**
 * Who was actually on the call: one row per participant, in a table under a
 * fixed header — Speaker/Facility, Role, Confidence.
 *
 * Reads `participants[]`, never tags, for the same reason the Mentions panel
 * does — `facility:` is emitted for both a participant's facility and a merely
 * mentioned one, so tags cannot separate the people on the radio from the
 * places they talked about.
 *
 * Person and facility share the Speaker/Facility column rather than getting
 * one each: the derivation names a person by name only when one was actually
 * said on the tape (most rows carry only a facility, e.g. "Boston"), and a
 * participant with both — a named person AND their facility — loses nothing
 * by stacking them in one cell instead of spreading across two.
 */
export const PartiesTab: React.FC<CardTabProps> = ({ meta }) => {
	const participants = meta?.participants ?? [];

	return (
		<div className={styles.rtTabPanel} data-tab="parties">
			{participants.length === 0 ? (
				<p className={styles.rtEmpty}>No parties identified.</p>
			) : (
				<table className={styles.rtPartiesTable}>
					<thead>
						<tr>
							<th scope="col">Speaker/Facility</th>
							<th scope="col">Role</th>
							<th scope="col">Confidence</th>
						</tr>
					</thead>
					<tbody>
						{participants.map((party, index) => {
							const badge = confidenceBadge(party.confidence);
							const person = party.person?.trim();
							const facility = party.facility?.trim();
							const role = party.role?.trim();
							return (
								<tr
									// Participants carry no id and two unnamed parties at the
									// same facility are a real shape, so position in the
									// derivation's own list is the only stable key.
									// biome-ignore lint/suspicious/noArrayIndexKey: no id on the wire
									key={index}
									data-participant={index}
								>
									<td data-field="speaker">
										{person && (
											<span className={styles.rtPartyField} data-field="person">
												{person}
											</span>
										)}
										{facility && (
											<span className={styles.rtPartyField} data-field="facility">
												{facility}
											</span>
										)}
									</td>
									<td data-field="role">
										{role && (
											<span className={styles.rtPartyField}>{role}</span>
										)}
									</td>
									<td data-field="confidence">
										{badge && (
											<span
												className={badge.className}
												data-confidence={badge.level}
											>
												{badge.text}
											</span>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			)}
		</div>
	);
};
