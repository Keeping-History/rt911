// Clock-driven NEXRAD composite radar overlay. The index describing available
// frames is a static Wasabi JSON manifest (see files.911realtime.org/weather/
// radar/index.json) — fetched once by WeatherMap's caller, not by this module.
// Everything here is pure: given the index and a UTC instant, resolve which
// frame image (if any) should be showing.

export interface RadarIndex {
	bounds: [number, number][];
	frames: string[];
	missing: string[];
	interval_seconds: number;
	key_prefix: string;
	key_pattern: string;
}

export const RADAR_BASE = "https://files.911realtime.org/";

function pad(n: number, width: number): string {
	return String(n).padStart(width, "0");
}

// Floor a UTC instant to the 300s (5min) radar cadence and format as the
// index's "YYYYMMDDHHMM" stamp. Deliberately uses UTC getters only — no
// locale/timezone APIs — since the manifest's frames[] are UTC-stamped.
export function stampForUtcMs(utcMs: number): string {
	const floored = Math.floor(utcMs / 300_000) * 300_000;
	const d = new Date(floored);
	return (
		String(d.getUTCFullYear()) +
		pad(d.getUTCMonth() + 1, 2) +
		pad(d.getUTCDate(), 2) +
		pad(d.getUTCHours(), 2) +
		pad(d.getUTCMinutes(), 2)
	);
}

// Resolve the frame URL to display at utcMs: the exact bucketed stamp if
// present in frames[], else the nearest EARLIER available frame (a binary
// search over the sorted frames[] array, walking back over gaps recorded in
// `missing`). Returns null if utcMs floors to before the first frame.
export function frameUrlFor(index: RadarIndex, utcMs: number): string | null {
	const { frames } = index;
	if (frames.length === 0) return null;
	const stamp = stampForUtcMs(utcMs);

	// Binary search for the rightmost frame <= stamp (frames[] is sorted ascending).
	let lo = 0;
	let hi = frames.length - 1;
	let idx = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (frames[mid] <= stamp) {
			idx = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	if (idx === -1) return null; // stamp is before the first available frame

	const resolvedStamp = frames[idx];
	return RADAR_BASE + index.key_prefix + index.key_pattern.replace("{stamp}", resolvedStamp);
}
