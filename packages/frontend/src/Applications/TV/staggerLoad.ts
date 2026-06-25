// Below this channel count the TV app mounts every player at once; above it,
// initial loading is bounded by a concurrency queue (see reconcile).
export const STAGGER_THRESHOLD = 4;

/** How many thumbnail players may load concurrently.
 *  K = clamp(deviceMemory ?? floor(cores/2) ?? THRESHOLD, 2, 8).
 *  deviceMemory (GiB, Chromium-only) is the best cheap proxy for memory
 *  headroom; core count is the cross-browser fallback. Neither is a true
 *  "max simultaneous decoders" signal — no such API exists — so this only
 *  *tunes* the cap; the queue mechanism is the actual safety net. */
export function computeConcurrency(
	channelCount: number,
	nav: { deviceMemory?: number; hardwareConcurrency?: number } = navigator,
): number {
	if (channelCount <= STAGGER_THRESHOLD) return channelCount;
	const fromCores =
		nav.hardwareConcurrency != null
			? Math.floor(nav.hardwareConcurrency / 2)
			: undefined;
	const raw = nav.deviceMemory ?? fromCores ?? STAGGER_THRESHOLD;
	return Math.min(8, Math.max(2, Math.round(raw)));
}
