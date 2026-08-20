// Shared "audio is waiting for a user gesture" signal for the Radio Scanner.
//
// Safari (and Chrome's autoplay policy) refuse to start sound on a page that
// has seen no user interaction: a restored session autoplays into silence —
// suspended AudioContexts and rejected play() calls — until the first click
// or keypress. The unlock retries themselves live in audioCapture.ts and
// StationPlayer.tsx; this module only aggregates "is anything still waiting?"
// so the UI can tell the user that a click is needed.
//
// Each blocked thing registers an arbitrary token (a context, an element id);
// the signal is simply "any tokens present". Subscribers are notified on
// blocked/unblocked flips only, which makes the store directly usable with
// useSyncExternalStore.

const tokens = new Set<unknown>();
const listeners = new Set<() => void>();

function notify(): void {
	for (const cb of listeners) cb();
}

export function isAudioBlocked(): boolean {
	return tokens.size > 0;
}

export function markAudioBlocked(token: unknown): void {
	const wasBlocked = tokens.size > 0;
	tokens.add(token);
	if (!wasBlocked && tokens.size > 0) notify();
}

export function clearAudioBlocked(token: unknown): void {
	const wasBlocked = tokens.size > 0;
	tokens.delete(token);
	if (wasBlocked && tokens.size === 0) notify();
}

export function subscribeAudioBlocked(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}
