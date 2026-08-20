import { type PhasePalette, phaseColorHex } from "./flightPhases";

interface PhasePoint {
	lat: number;
	lon: number;
	phase?: string;
	// Provenance (#263) — segments also break where radar coverage does, so
	// the drawn line can distinguish surveyed from estimated stretches.
	source?: string;
}

/**
 * Split a phase-tagged point list into one LineString Feature per maximal run
 * of the same phase. Adjacent segments SHARE the boundary vertex (the run's
 * last point is repeated as the next run's first) so the colored line has no
 * gap at the phase change. Each Feature carries properties.phase. Fewer than
 * two points cannot form a line → [].
 *
 * `palette` selects which phase vocabulary the colors come from (see
 * flightPhases.phasePaletteFor); the resolved color is stamped on each feature
 * so the map layer's fixed paint expression doesn't have to know the flight.
 */
export function buildTrackSegments(
	points: PhasePoint[],
	palette?: PhasePalette,
): GeoJSON.Feature[] {
	if (points.length < 2) return [];
	const features: GeoJSON.Feature[] = [];
	let start = 0;
	// A run ends when EITHER the phase or the provenance changes, so a track
	// can be colored by phase and dashed by provenance at the same time.
	const runKey = (p: PhasePoint) => `${p.phase ?? ""}|${p.source ?? ""}`;
	const flush = (end: number) => {
		// include the boundary vertex at `end` so segments join seamlessly.
		const slice = points.slice(start, end + 1);
		if (slice.length < 2) return;
		features.push({
			type: "Feature",
			properties: {
				phase: points[start].phase ?? null,
				source: points[start].source ?? null,
				color: phaseColorHex(points[start].phase, palette),
			},
			geometry: {
				type: "LineString",
				coordinates: slice.map((p) => [p.lon, p.lat]),
			},
		});
	};
	for (let i = 1; i < points.length; i++) {
		if (runKey(points[i]) !== runKey(points[start])) {
			flush(i); // boundary vertex i belongs to both runs
			start = i;
		}
	}
	flush(points.length - 1);
	return features;
}
