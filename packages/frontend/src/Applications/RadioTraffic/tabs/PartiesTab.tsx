import type React from "react";
import type { Participant } from "../../../Providers/MediaStream/MediaStreamContext";
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

/** The fields a party column prints, in the order it prints them. */
const PARTY_FIELDS: [keyof Participant, string][] = [
	["person", "person"],
	["facility", "facility"],
	["role", "role"],
];

/**
 * Who was actually on the call: one column per participant.
 *
 * Reads `participants[]`, never tags, for the same reason the Mentions panel
 * does — `facility:` is emitted for both a participant's facility and a merely
 * mentioned one, so tags cannot separate the people on the radio from the
 * places they talked about.
 */
export const PartiesTab: React.FC<CardTabProps> = ({ meta }) => {
	const participants = meta?.participants ?? [];

	return (
		<div className={styles.rtTabPanel} data-tab="parties">
			{participants.length === 0 ? (
				<p className={styles.rtEmpty}>No parties identified.</p>
			) : (
				<div className={styles.rtColumns}>
					{participants.map((party, index) => {
						const badge = confidenceBadge(party.confidence);
						return (
							<div
								// Participants carry no id and two unnamed parties at the
								// same facility are a real shape, so position in the
								// derivation's own list is the only stable key.
								// biome-ignore lint/suspicious/noArrayIndexKey: no id on the wire
								key={index}
								className={styles.rtColumn}
								data-participant={index}
							>
								{PARTY_FIELDS.map(([key, field]) =>
									party[key]?.trim() ? (
										<span
											key={field}
											className={styles.rtPartyField}
											data-field={field}
										>
											{party[key]}
										</span>
									) : null,
								)}
								{badge ? (
									<span
										className={badge.className}
										data-confidence={badge.level}
									>
										{badge.text}
									</span>
								) : null}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};
