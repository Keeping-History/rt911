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

export type LoadPhase = "idle" | "loading" | "loaded";

/** True once a player should have a live <ReactPlayer> in the DOM. */
export function shouldMount(phase: Map<number, LoadPhase>, id: number): boolean {
	const p = phase.get(id);
	return p === "loading" || p === "loaded";
}

/** Mark a player's initial load complete (called from onReady). */
export function markLoaded(
	prev: Map<number, LoadPhase>,
	id: number,
): Map<number, LoadPhase> {
	if (prev.get(id) !== "loading") return prev;
	const next = new Map(prev);
	next.set(id, "loaded");
	return next;
}

/** Recompute load phases. Prunes off-screen players to idle (unmount), keeps
 *  `loading` within `concurrency`, and promotes visible idle players —
 *  priority ids first — into freed slots. `loaded` players do not consume
 *  budget; they have finished their initial fetch. */
export function reconcile(
	prev: Map<number, LoadPhase>,
	opts: { visibleIds: number[]; priorityIds: number[]; concurrency: number },
): Map<number, LoadPhase> {
	const { visibleIds, priorityIds, concurrency } = opts;
	const visible = new Set(visibleIds);
	const next = new Map<number, LoadPhase>();

	// Carry forward only still-visible players; drop the rest (they unmount).
	let loadingCount = 0;
	for (const id of visibleIds) {
		const p = prev.get(id);
		if (p === "loading" || p === "loaded") {
			next.set(id, p);
			if (p === "loading") loadingCount++;
		} else {
			next.set(id, "idle");
		}
	}

	// Promote idle visible players into free slots, priority first.
	const ordered = [
		...priorityIds.filter((id) => visible.has(id)),
		...visibleIds.filter((id) => !priorityIds.includes(id)),
	];
	for (const id of ordered) {
		if (loadingCount >= concurrency) break;
		if (next.get(id) === "idle") {
			next.set(id, "loading");
			loadingCount++;
		}
	}
	return next;
}

/** hls.js buffer caps per quality tier. Thumbnails hold only a few seconds and
 *  no back-buffer so each idle instance's memory stays small; the focused
 *  player gets a roomier forward buffer. Levels match TV.tsx's QUALITY_*. */
export function bufferCapsForLevel(level: number): {
	maxBufferLength: number;
	backBufferLength: number;
	maxBufferSize: number;
} {
	if (level >= 2) {
		return { maxBufferLength: 30, backBufferLength: 10, maxBufferSize: 60 * 1000 * 1000 };
	}
	if (level === 1) {
		return { maxBufferLength: 10, backBufferLength: 0, maxBufferSize: 20 * 1000 * 1000 };
	}
	return { maxBufferLength: 6, backBufferLength: 0, maxBufferSize: 10 * 1000 * 1000 };
}
