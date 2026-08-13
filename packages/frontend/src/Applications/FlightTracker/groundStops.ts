// Curated ground-stop intervals for flights that park mid-day (AF1's
// Sarasota/Barksdale/Offutt stops), carried in flight_tracks.details.
// The detail panel matches the replay clock against them to say WHERE a
// grounded aircraft is — the position row's phase says only THAT it's parked.
export interface GroundStop {
	code: string;
	name: string;
	start: string; // UTC ISO ...Z
	end: string;
}

export function groundStopAt(
	details: { ground_stops?: GroundStop[] } | null | undefined,
	nowMs: number,
): GroundStop | null {
	for (const stop of details?.ground_stops ?? []) {
		const start = Date.parse(stop.start);
		const end = Date.parse(stop.end);
		if (Number.isNaN(start) || Number.isNaN(end)) continue;
		if (start <= nowMs && nowMs <= end) return stop;
	}
	return null;
}
