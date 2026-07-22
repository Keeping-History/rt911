import type { ExpressionSpecification } from "maplibre-gl";

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
};

// Coarse altitude phases (climb/cruise/descent) and unknowns fall back to the
// existing flat track red, so non-notable flights render exactly as before.
export const DEFAULT_PHASE_COLOR = "#b22222";

export function phaseColorHex(phase?: string): string {
	// `phase ? …` (not `phase && …`) so an empty string also falls through to
	// the default instead of returning "" (which would parse to a NaN color).
	return (phase ? PHASE_COLORS[phase] : undefined) ?? DEFAULT_PHASE_COLOR;
}

export function phaseColorRgb01(phase?: string): [number, number, number] {
	const n = Number.parseInt(phaseColorHex(phase).slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Data-driven line-color for the 2D track: each per-phase segment feature
// carries properties.phase; unknown/absent phases hit the default red.
export function phaseLineColorExpression(): ExpressionSpecification {
	const cases: (string)[] = [];
	for (const [slug, hex] of Object.entries(PHASE_COLORS)) {
		cases.push(slug, hex);
	}
	return [
		"match",
		["get", "phase"],
		...cases,
		DEFAULT_PHASE_COLOR,
	] as unknown as ExpressionSpecification;
}
