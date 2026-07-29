import type { ExpressionSpecification } from "maplibre-gl";

// Track provenance (#263). Every flight on the map is "reconstructed from
// radar tracks and, where not available, historical tracks" — this module
// draws that distinction on the selected flight's track, the same way
// flightPhases colors the notable flights' phases.
//
// Values match flight_positions.source written by rades_load:
//   "radar"     — an 84 RADES surveyed position
//   "estimated" — great-circle fill where the radars had no coverage
//   (absent)    — a wholly historical (BTS) reconstruction

export const SOURCE_RADAR = "radar";
export const SOURCE_ESTIMATED = "estimated";

/** The single sentence that answers "where did this track come from?".
 * Every surface that discloses provenance must render THIS string — two
 * near-miss phrasings previously coexisted in the detail pane and could both
 * appear at once, since one was gated on a missing route and the other on
 * loaded source tags. */
export const PROVENANCE_NOTE =
	"Flight paths are reconstructed from radar tracks and, where radar " +
	"coverage was unavailable, historical flight records.";

/** Solid, confident line for surveyed radar; the estimated fill is drawn in
 * the same hue but dashed and dimmed, so the shape reads as one flight while
 * the provenance stays legible. */
export const SOURCE_DASH_ARRAY: [number, number] = [2, 2];

export function isEstimated(source?: string): boolean {
	return source === SOURCE_ESTIMATED;
}

/** Data-driven dash pattern: estimated segments dashed, everything else solid. */
export function sourceDashExpression(): ExpressionSpecification {
	return [
		"case",
		["==", ["get", "source"], SOURCE_ESTIMATED],
		["literal", SOURCE_DASH_ARRAY],
		["literal", [1, 0]],
	] as unknown as ExpressionSpecification;
}

/** Estimated segments render at reduced opacity; radar at full. */
export function sourceOpacityExpression(): ExpressionSpecification {
	return [
		"case",
		["==", ["get", "source"], SOURCE_ESTIMATED],
		0.55,
		1,
	] as unknown as ExpressionSpecification;
}

export const SOURCE_LABELS: Record<string, string> = {
	[SOURCE_RADAR]: "Radar track",
	[SOURCE_ESTIMATED]: "Estimated (no radar coverage)",
};

export function sourceLabel(source: string): string {
	return SOURCE_LABELS[source] ?? source;
}

/** Ordered-unique source values in track order — mirrors the drawn segments
 * so the legend lists exactly what is on the map. */
export function orderedTrackSources(points: { source?: string }[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of points) {
		const s = p.source ?? SOURCE_RADAR;
		if (!seen.has(s)) {
			seen.add(s);
			out.push(s);
		}
	}
	return out;
}
