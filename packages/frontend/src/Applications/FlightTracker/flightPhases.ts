import type { ExpressionSpecification } from "maplibre-gl";
import { isNotable } from "./notableFlights";

// Escalation-ramp palette for the 4 hijacked flights (issue #229): calm
// green→teal→blue for normal ops, warming to red/maroon as the crisis
// escalates. Slugs match flight_positions.phase written by the notable loader.
export const PHASE_COLORS: Record<string, string> = {
	takeoff: "#2e7d32",
	tracon: "#0097a7",
	artcc: "#1565c0",
	hijack: "#f9a825",
	course_change: "#ef6c00",
	atc_alert: "#d84315",
	descent: "#c62828",
	down: "#7f0000",
	// AF1 parked stretches — neutral, outside the escalation ramp
	ground: "#8a8a8a",
};

// Normal-operations palette for the altitude-derived phases the resampler
// writes (resample._assign_phases) — what a curated flight that was never
// hijacked carries, e.g. AF1. It deliberately reuses the escalation ramp's
// CALM colors for the equivalent flight regimes, so both kinds of track read
// as one system: departure green, en-route blue, terminal-area teal.
//
// `descent` is the one slug both vocabularies use, and it means opposite
// things: the hijacked four's curated `descent` is the final dive (crisis
// red), while an altitude-derived `descent` is a routine approach. That
// collision is why the palette is chosen per flight instead of globally —
// recoloring `descent` for everyone would drain the escalation ramp.
export const NORMAL_PHASE_COLORS: Record<string, string> = {
	climb: "#2e7d32", // as takeoff — departure
	cruise: "#1565c0", // as artcc — en route
	descent: "#0097a7", // as tracon — terminal area / approach
	ground: "#8a8a8a", // the same neutral both palettes use
};

// Unknown phases (and any flight with no phase profile at all) fall back to
// the flat track red, so ordinary BTS flights render exactly as before.
export const DEFAULT_PHASE_COLOR = "#b22222";

/** Which vocabulary a flight's `phase` values belong to. */
export type PhasePalette = "escalation" | "normal";

/**
 * The hijacked four carry the curated escalation ramp; every other curated
 * flight (AF1 today) carries altitude-derived phases. Keyed off `isNotable`
 * because that is exactly the set the notable loader writes curated phases for.
 */
export function phasePaletteFor(flight?: string): PhasePalette {
	return flight && isNotable(flight) ? "escalation" : "normal";
}

function colorsFor(palette: PhasePalette = "escalation"): Record<string, string> {
	return palette === "normal" ? NORMAL_PHASE_COLORS : PHASE_COLORS;
}

export function phaseColorHex(phase?: string, palette?: PhasePalette): string {
	// `phase ? …` (not `phase && …`) so an empty string also falls through to
	// the default instead of returning "" (which would parse to a NaN color).
	return (phase ? colorsFor(palette)[phase] : undefined) ?? DEFAULT_PHASE_COLOR;
}

export function phaseColorRgb01(
	phase?: string,
	palette?: PhasePalette,
): [number, number, number] {
	const n = Number.parseInt(phaseColorHex(phase, palette).slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Data-driven line-color for the 2D track. The layer's paint is fixed when the
// layer is added, but the palette depends on which flight is selected — so
// buildTrackSegments resolves each segment's color up front and stamps it as
// properties.color, and this expression simply prefers it. Features without one
// (a plain undecorated track geometry) still match the escalation ramp by slug,
// then fall through to the flat red.
export function phaseLineColorExpression(): ExpressionSpecification {
	const cases: (string)[] = [];
	for (const [slug, hex] of Object.entries(PHASE_COLORS)) {
		cases.push(slug, hex);
	}
	return [
		"coalesce",
		["get", "color"],
		["match", ["get", "phase"], ...cases, DEFAULT_PHASE_COLOR],
	] as unknown as ExpressionSpecification;
}

// Human-readable phase names for the detail-pane legend (issue #310). Keys match
// PHASE_COLORS slugs written by the notable loader.
export const PHASE_LABELS: Record<string, string> = {
	takeoff: "Takeoff",
	tracon: "TRACON",
	artcc: "ARTCC",
	hijack: "Hijack",
	course_change: "Course Change",
	atc_alert: "ATC Alert",
	descent: "Descent",
	down: "Down",
	ground: "On Ground",
	// Altitude-derived phases (resample._assign_phases). Only flights whose
	// legend is enabled — the notables and AF1 — ever surface these, but without
	// entries here they render as raw lowercase slugs next to the labeled ones.
	climb: "Climb",
	cruise: "Cruise",
};

export function phaseLabel(phase: string): string {
	return PHASE_LABELS[phase] ?? phase;
}

// Ordered-unique phase slugs in track order (first occurrence wins); points
// without a phase are skipped. Mirrors the per-phase segments buildTrackSegments
// draws, so the legend lists exactly the colors shown on the map.
export function orderedTrackPhases(points: { phase?: string }[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of points) {
		if (p.phase && !seen.has(p.phase)) {
			seen.add(p.phase);
			out.push(p.phase);
		}
	}
	return out;
}
