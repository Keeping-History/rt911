// Single source of truth for which radio *stations* may have audio playing.
//
// A "station" is a group of MediaItems sharing a source (see stationGrouping.ts),
// identified by a string key. The Radio Scanner has two modes:
//   - Scan mode: the user hand-picks stations that all play together.
//   - Single-station mode (default): exactly one station — the active one — plays.
export interface PlaybackSelection {
	scannerMode: boolean;
	activeStation: string;
	selectedStations: string[];
}

export function shouldStationPlay(sel: PlaybackSelection, key: string): boolean {
	return sel.scannerMode
		? sel.selectedStations.includes(key)
		: key === sel.activeStation;
}

/** Keep only string entries — drops legacy numeric ids from old persisted state. */
export function sanitizeStationKeys(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
}

/** Coerce a persisted active-station value to a string key ('' for legacy ids). */
export function sanitizeActiveStation(value: unknown): string {
	return typeof value === "string" ? value : "";
}
