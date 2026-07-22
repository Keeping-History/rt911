interface PhasePoint {
	lat: number;
	lon: number;
	phase?: string;
}

/**
 * Split a phase-tagged point list into one LineString Feature per maximal run
 * of the same phase. Adjacent segments SHARE the boundary vertex (the run's
 * last point is repeated as the next run's first) so the colored line has no
 * gap at the phase change. Each Feature carries properties.phase. Fewer than
 * two points cannot form a line → [].
 */
export function buildTrackSegments(points: PhasePoint[]): GeoJSON.Feature[] {
	if (points.length < 2) return [];
	const features: GeoJSON.Feature[] = [];
	let start = 0;
	const flush = (end: number) => {
		// include the boundary vertex at `end` so segments join seamlessly.
		const slice = points.slice(start, end + 1);
		if (slice.length < 2) return;
		features.push({
			type: "Feature",
			properties: { phase: points[start].phase ?? null },
			geometry: {
				type: "LineString",
				coordinates: slice.map((p) => [p.lon, p.lat]),
			},
		});
	};
	for (let i = 1; i < points.length; i++) {
		if (points[i].phase !== points[start].phase) {
			flush(i); // boundary vertex i belongs to both runs
			start = i;
		}
	}
	flush(points.length - 1);
	return features;
}
