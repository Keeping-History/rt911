import type React from "react";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";
import { provenanceRows } from "./provenance";

/**
 * Where the card's claims came from: the commission citation, what each
 * published field is owed to, and when the derivation ran.
 *
 * This is the only panel whose data is typed `unknown` on the wire, so the
 * narrowing lives in provenanceRows and this component only ever sees a list
 * of label/value pairs — an unexpected blob costs an empty panel, not a card
 * that throws mid-render.
 */
export const SourceTab: React.FC<CardTabProps> = ({ meta }) => {
	const rows = provenanceRows(meta?.provenance);

	return (
		<div className={styles.rtTabPanel} data-tab="source">
			{rows.length === 0 ? (
				<p className={styles.rtEmpty}>No provenance recorded.</p>
			) : (
				<dl className={styles.rtDetailRows}>
					{rows.map((row) => (
						<div
							key={`${row.label}:${row.value}`}
							className={styles.rtDetailRow}
							data-row={row.label}
						>
							<dt className={styles.rtDetailLabel}>{row.label}</dt>
							<dd className={styles.rtDetailValue}>{row.value}</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	);
};
