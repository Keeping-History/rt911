// Shared per-element WebAudio capture for the Radio Scanner.
//
// createMediaElementSource() may be called only once per element and the
// capture is permanent: from then on the element is heard only through the
// AudioContext graph. Safari stops honoring el.volume — and el.muted — on
// captured elements (verified on macOS Safari, 2026-07), so silencing must
// happen inside the graph itself: a GainNode between the source and the
// speakers, which every browser honors by specification.
//
// This module owns the capture. WaveformVisualizer asks for an element's
// entry to attach its analyser; StationPlayer drives the gain in lockstep
// with its el.volume/el.muted muting. The WeakMaps let entries be collected
// with their audio elements.

export interface CapturedAudio {
	ctx: AudioContext;
	source: MediaElementAudioSourceNode;
	gain: GainNode;
}

const captured = new WeakMap<HTMLAudioElement, CapturedAudio>();
// Desired mute state, remembered even before capture: a clip muted while
// native (never yet primary) must come up silent if it later gets captured.
const desiredSilenced = new WeakMap<HTMLAudioElement, boolean>();

// A context created before the page's first user gesture (e.g. a restored
// session autoplaying on load) starts out suspended in Safari, and resume()
// is refused unless called during a real user activation. Remember those
// contexts and retry from document-level gesture listeners — a captured
// element is audible only through its context, so until this succeeds it
// plays in silence.
const awaitingGesture = new Set<CapturedAudio["ctx"]>();

function resumeAwaitingContexts(): void {
	for (const ctx of awaitingGesture) {
		if (ctx.state !== "suspended") {
			awaitingGesture.delete(ctx);
			continue;
		}
		ctx.resume()
			.then(() => awaitingGesture.delete(ctx))
			.catch(() => {});
	}
}

if (typeof document !== "undefined") {
	document.addEventListener("click", resumeAwaitingContexts, true);
	document.addEventListener("keydown", resumeAwaitingContexts, true);
	// The mobile click wheel preventDefault()s pointerdown, which suppresses
	// the synthetic click — listen for the pointer event itself as well.
	document.addEventListener("pointerdown", resumeAwaitingContexts, true);
}

/** Get or create the permanent capture chain (source → gain → destination). */
export function captureAudioElement(el: HTMLAudioElement): CapturedAudio | null {
	let entry = captured.get(el);
	if (!entry) {
		try {
			const ctx = new AudioContext();
			const source = ctx.createMediaElementSource(el);
			const gain = ctx.createGain();
			source.connect(gain);
			gain.connect(ctx.destination);
			entry = { ctx, source, gain };
		} catch {
			return null;
		}
		entry.gain.gain.value = desiredSilenced.get(el) ? 0 : 1;
		captured.set(el, entry);
		if (entry.ctx.state === "suspended") awaitingGesture.add(entry.ctx);
	}
	return entry;
}

/**
 * Record whether `el` should be silent and, if it is (or later becomes)
 * captured, enforce it in-graph. Gain does not affect autoplay permission,
 * so unlike el.muted this needs no autoplay-unlock gating.
 */
export function setAudioSilenced(el: HTMLAudioElement, silenced: boolean): void {
	desiredSilenced.set(el, silenced);
	const entry = captured.get(el);
	if (entry) entry.gain.gain.value = silenced ? 0 : 1;
}
