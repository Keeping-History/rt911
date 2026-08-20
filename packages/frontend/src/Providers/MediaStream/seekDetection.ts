// Deciding when a virtual-clock change is a "seek" — i.e. large/unnatural enough
// that the client must drop its buffered timeline and re-request a fresh window
// + snapshot from the streamer, rather than let the ordinary reveal tick carry
// it across.
//
// The virtual clock only ever *auto-advances forward*, ~1 minute per tick, so
// the two directions need DIFFERENT thresholds:
//
//   - Forward: an ordinary tick moves the clock ~60s. A forward jump must be
//     comfortably larger than a tick to count as a manual seek, otherwise every
//     minute boundary would trigger a server refill storm. Hence SEEK_THRESHOLD_MS
//     (90s) — a tick's worth plus slack.
//
//   - Backward: the clock NEVER rewinds on its own, so any non-trivial backward
//     move is a deliberate seek (a Time Machine rewind, a playlist jump-back, or
//     a forced-clock correction). Using the forward 90s threshold here was the
//     bug: a rewind of a minute or less wasn't treated as a seek, so no fresh
//     window was fetched — and because the reveal buffer *deletes* an item once
//     it surfaces (see revealBuffer.ts `drainDue`), the leading-edge retention
//     then dropped the now-future item with nothing left to re-reveal it. Radio
//     "now playing" / "Coming Up" entries silently vanished on small rewinds.
//     A rewind past BACKWARD_SEEK_THRESHOLD_MS re-syncs instead.
//
// The backward threshold matches FORCED_DRIFT_THRESHOLD_MS so that ordinary
// forced-clock drift corrections (which only snap the clock once drift exceeds
// that) sit right at the boundary rather than each spuriously forcing a refetch.

export const SEEK_THRESHOLD_MS = 90_000;
export const BACKWARD_SEEK_THRESHOLD_MS = 2_000;

/**
 * True when moving the virtual clock from `prevMs` to `nowMs` should be handled
 * as a seek (clear buffers, re-request the window). Forward jumps use the larger
 * SEEK_THRESHOLD_MS; any backward move beyond BACKWARD_SEEK_THRESHOLD_MS counts.
 */
export function shouldSeek(prevMs: number, nowMs: number): boolean {
	const delta = nowMs - prevMs;
	return delta > SEEK_THRESHOLD_MS || delta < -BACKWARD_SEEK_THRESHOLD_MS;
}
