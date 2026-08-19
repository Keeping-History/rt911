// Reading ItemMeta.provenance for the Source panel.
//
// `provenance` is typed `unknown` on the wire deliberately — nothing rendered
// it when the type was written, and guessing a shape no consumer read would
// have been a guess about a display that did not exist. This module is that
// display, so the narrowing lives here: every branch degrades to "no rows"
// rather than throwing, because a producer changing the blob's shape must cost
// a blank panel inside one card, not a thrown render that takes the app down.

export interface ProvenanceRow {
	label: string;
	value: string;
}

/** The commission citation's fields, in the order a citation reads. */
const COMMISSION_FIELDS: [key: string, label: string][] = [
	["title", "Title"],
	["source", "Source"],
	["stamp", "Stamp"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A printable form of a leaf, or null when there is nothing worth printing. */
function scalarText(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return null;
	// A structured source ("subject came from {from: transcript}") is rare but
	// legible as JSON; the alternative is the literal text "[object Object]".
	return JSON.stringify(value);
}

/** "start_date" -> "Start date": a sources key names the field it accounts for. */
function pathLabel(key: string): string {
	const words = key.replace(/[._]+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The label/value rows the Source panel prints, in reading order: where the
 * account came from (commission), what each published field is owed to
 * (sources), and when the derivation ran.
 */
export function provenanceRows(provenance: unknown): ProvenanceRow[] {
	if (!isRecord(provenance)) return [];
	const rows: ProvenanceRow[] = [];

	const commission = provenance.commission;
	if (isRecord(commission)) {
		for (const [key, label] of COMMISSION_FIELDS) {
			const value = scalarText(commission[key]);
			if (value !== null) rows.push({ label, value });
		}
	}

	const sources = provenance.sources;
	if (isRecord(sources)) {
		for (const [key, raw] of Object.entries(sources)) {
			const value = scalarText(raw);
			if (value !== null) rows.push({ label: pathLabel(key), value });
		}
	}

	const generated = scalarText(provenance.generated_at);
	if (generated !== null) rows.push({ label: "Generated", value: generated });

	return rows;
}
