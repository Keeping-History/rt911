// Per-station merge for the weather channel's observation state.
//
// Unlike pager/flights (instant items retained by id, self-pruning on a short
// window), weather observations are kept as ONE entry per station — the most
// recent reading, however old, mirroring the server's snapshot semantics
// (weather-protocol.md: "a station that has been silent for hours still shows
// its last reading"). A late-arriving frame (network reorder, or the overlap
// between a subscribe/init/seek snapshot and the first forward-window refill)
// can carry a fresh `id` for a station whose observation is actually OLDER
// than what's already held — id-based dedup (mergeById) would wrongly let that
// stale row win. This merge compares `start_date` per station instead.

import type { WeatherObservation } from "./MediaStreamContext";

// Merge freshly-received observations into the current per-station record.
// For each incoming observation, it replaces the station's entry only if its
// start_date is >= the entry currently held (ties favor incoming — the latest
// frame received is assumed to be the most authoritative for that instant).
// Strictly older incoming observations are ignored. Returns the SAME `current`
// reference when nothing actually changed, so callers doing
// `setState((prev) => mergeLatestPerStation(prev, incoming))` don't trigger a
// re-render for a frame that turned out to be entirely stale.
export function mergeLatestPerStation(
	current: Record<string, WeatherObservation>,
	incoming: WeatherObservation[],
): Record<string, WeatherObservation> {
	let next: Record<string, WeatherObservation> | null = null;

	for (const obs of incoming) {
		const existing = current[obs.station_id];
		const wins =
			!existing ||
			new Date(obs.start_date).getTime() >= new Date(existing.start_date).getTime();
		if (!wins) continue;
		if (next === null) next = { ...current };
		next[obs.station_id] = obs;
	}

	return next ?? current;
}
