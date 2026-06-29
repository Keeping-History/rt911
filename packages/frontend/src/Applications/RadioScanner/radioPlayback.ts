// Single source of truth for which radio *station* is active.
//
// The Radio Scanner plays one station at a time — the active one.
export interface PlaybackSelection {
	activeStation: string;
}

export function shouldStationPlay(sel: PlaybackSelection, key: string): boolean {
	return key === sel.activeStation;
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

/** Keep only finite numbers — drops anything malformed from persisted state. */
export function sanitizeItemIds(value: unknown): number[] {
	return Array.isArray(value)
		? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
		: [];
}
