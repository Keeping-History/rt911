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

/** One-time aggressive bump used when a channel gains single-view focus:
 *  optimistically reset the bandwidth estimate (future auto decisions), then
 *  force `nextLevel` (flushes buffered low-res so the improvement is visible
 *  now, not after ~30s of buffer drains). Setting `nextLevel` puts hls.js in
 *  MANUAL mode, so auto is restored on the next level switch — the bump is a
 *  nudge, not a pin: if bandwidth can't sustain the level, ABR degrades as
 *  usual afterward.
 *
 *  A channel switch remounts the player embed, and `onReady` can fire before
 *  hls.js has started anything — `currentLevel` still at its unset -1, with
 *  nothing buffered to flush. Forcing `nextLevel` at that point strands
 *  hls.js in manual mode with no fragment in flight, so `hlsLevelSwitched`
 *  never fires and auto is never restored: the player wedges. Skip the force
 *  whenever playback hasn't started yet — the per-player `startLevel`
 *  config already loads a fresh mount at the ceiling, so there's nothing to
 *  bump. */
export function bumpToLevel(api: HlsAbrApi, level: number): void {
	api.bandwidthEstimate = OPTIMISTIC_BANDWIDTH_ESTIMATE;
	if (api.currentLevel === level || api.currentLevel < 0) return; // already there, or nothing played yet — nothing to flush
	api.nextLevel = level;
	api.once("hlsLevelSwitched", () => {
		api.nextLevel = -1;
	});
}

/** Recurring watchdog probe: when a player is parked below its tier ceiling
 *  despite a healthy buffer, force exactly ONE fragment at the next level up
 *  (`nextLoadLevel` — no flush, auto mode preserved). The fragment's real
 *  throughput sample feeds the EWMA, so if bandwidth is genuinely good ABR
 *  keeps the higher level on its own; if not, it falls back and the watchdog
 *  retries on the next health-check tick. This is what un-sticks a player
 *  parked at thumb on a stale low estimate. Uses `loadLevel` (not
 *  `currentLevel`) so a probe never drags an already-climbing loader back
 *  down. Returns true when a probe was issued. */
export function maybeProbeUp(
	el: BufferedMedia,
	api: HlsAbrApi | undefined,
	ceiling: number,
): boolean {
	if (!api || !api.autoLevelEnabled) return false;
	if (api.loadLevel >= ceiling) return false;
	if (el.paused || el.ended) return false;
	if (bufferedAheadSeconds(el) < WATCHDOG_MIN_BUFFER_S) return false;
	api.nextLoadLevel = api.loadLevel + 1;
	return true;
}
