/**
 * Run non-urgent boot work after the main thread has gone idle, so it never
 * competes with first paint or the user's first taps. iOS Safari gained
 * requestIdleCallback only recently, so older WebKit falls back to a fixed
 * post-boot delay. The `timeout` bounds how long "idle" can be deferred on a
 * busy page before the work runs anyway.
 */
export function runWhenIdle(work: () => void, timeoutMs = 10000): void {
	if (typeof window.requestIdleCallback === "function") {
		window.requestIdleCallback(() => work(), { timeout: timeoutMs });
	} else {
		window.setTimeout(work, Math.min(timeoutMs, 5000));
	}
}
