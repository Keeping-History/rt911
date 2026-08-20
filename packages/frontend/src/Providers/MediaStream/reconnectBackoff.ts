// Reconnect backoff for the streamer WebSocket.
//
// The first retry is quick because the overwhelmingly common cause of a dropped
// socket is a streamer rollout, which is over in seconds. The cap keeps a client
// left open on a dead network from retrying forever at speed.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Exponential backoff with jitter, in ms, for the nth consecutive failure.
 *
 * `random` is injectable so the schedule can be asserted without flake.
 *
 * The jitter is not decoration. Every connected client loses its socket in the
 * same instant when the streamer rolls, so a fixed schedule would march the
 * entire fleet back in lockstep and hit the pod with one synchronised thundering
 * herd exactly as it is warming its Redis cache. Spreading arrivals across the
 * window is what keeps the recovery gradual.
 */
export function reconnectDelayMs(
	attempt: number,
	random: () => number = Math.random,
): number {
	const capped = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
	return Math.round(capped * (1 + random() * 0.5));
}
