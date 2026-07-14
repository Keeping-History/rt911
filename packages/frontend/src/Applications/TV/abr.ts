// Aggressive ABR helpers for TV.app (issue #149). The encoder ships a fixed
// 3-rendition ladder (thumb 136k / mid 396k / full 2628k); hls.js defaults are
// tuned for deep ladders and lazy up-switching, which parked players at thumb.
// These helpers bias ABR strongly upward while keeping thumb selectable as a
// genuine last resort — upward pressure, never a floor.

/** Estimate handed to fresh/refocused players: assume a good connection until
 *  measured otherwise. hls.js's 500k default is below the full rendition's
 *  2628k, so an untouched player literally cannot pick full at start. */
export const OPTIMISTIC_BANDWIDTH_ESTIMATE = 5_000_000;

/** Minimum buffered seconds ahead of the playhead before the watchdog dares an
 *  upward probe — a healthy buffer means the current level is comfortably
 *  sustainable, so spending one fragment on a higher level is safe. */
export const WATCHDOG_MIN_BUFFER_S = 10;

/** Per-player hls.js config overrides, spread into each player's config. */
export const TV_ABR_CONFIG = {
	abrEwmaDefaultEstimate: OPTIMISTIC_BANDWIDTH_ESTIMATE,
	// Up-switch to full at ~2.9Mbps measured instead of the default ~3.75Mbps.
	abrBandWidthUpFactor: 0.9,
	// Shorter EWMA half-lives (defaults 3/9): a transient dip stops dragging
	// the estimate down within seconds instead of minutes.
	abrEwmaFastVoD: 2,
	abrEwmaSlowVoD: 5,
} as const;

/** The slice of the hls.js instance (exposed by hls-video-element as `.api`)
 *  that the TV app's quality steering touches. */
export type HlsAbrApi = {
	autoLevelCapping: number;
	autoLevelEnabled: boolean;
	bandwidthEstimate: number;
	currentLevel: number;
	loadLevel: number;
	nextLevel: number;
	nextLoadLevel: number;
	once(event: string, cb: () => void): void;
};

/** The slice of an HTMLMediaElement the buffer-health check reads. */
export type BufferedMedia = Pick<
	HTMLVideoElement,
	"buffered" | "currentTime" | "paused" | "ended"
>;

/** Seconds of buffered media ahead of the playhead (0 if the playhead is
 *  outside every buffered range). */
export function bufferedAheadSeconds(el: BufferedMedia): number {
	const { buffered, currentTime } = el;
	for (let i = 0; i < buffered.length; i++) {
		if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
			return buffered.end(i) - currentTime;
		}
	}
	return 0;
}
