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
// entry to attach its analyser; StationPlayer drives the gain level in lockstep
// with its el.volume/el.muted handling. Issue #564's Split feature is a third
// consumer, and the odd one out: RadioTraffic never mounts WaveformVisualizer
// (its cards draw a static peaks envelope instead — see PeaksWaveform.tsx), so
// nothing here captures its elements today. audioCoordinator.ts calls
// captureAudioElement itself, on demand, the moment a clip actually needs to be
// panned off-center — see that module's `applySplitPanning`. The WeakMaps let
// entries be collected with their audio elements.

import { clearAudioBlocked, markAudioBlocked } from "./audioBlocked";

export interface CapturedAudio {
	ctx: AudioContext;
	source: MediaElementAudioSourceNode;
	panner: StereoPannerNode;
	gain: GainNode;
}

const captured = new WeakMap<HTMLAudioElement, CapturedAudio>();
// Desired volume level (0..1), remembered even before capture: a clip whose
// level was set while native (never yet primary) must come up at that level
// if it later gets captured. 0 = silenced.
const desiredVolume = new WeakMap<HTMLAudioElement, number>();
// Desired stereo position (-1 full left .. 0 center .. 1 full right),
// remembered the same way and for the same reason — Split can be toggled on
// before an element has ever needed capturing.
const desiredPan = new WeakMap<HTMLAudioElement, number>();

// A context created before the page's first user gesture (e.g. a restored
// session autoplaying on load) starts out suspended in Safari, and resume()
// is refused unless called during a real user activation. Remember those
// contexts and retry from document-level gesture listeners — a captured
// element is audible only through its context, so until this succeeds it
// plays in silence.
const awaitingGesture = new Set<CapturedAudio["ctx"]>();

function releaseContext(ctx: CapturedAudio["ctx"]): void {
	awaitingGesture.delete(ctx);
	clearAudioBlocked(ctx);
}

function resumeAwaitingContexts(): void {
	for (const ctx of awaitingGesture) {
		if (ctx.state !== "suspended") {
			releaseContext(ctx);
			continue;
		}
		ctx.resume()
			.then(() => releaseContext(ctx))
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

/** Get or create the permanent capture chain (source → panner → gain → destination). */
export function captureAudioElement(el: HTMLAudioElement): CapturedAudio | null {
	let entry = captured.get(el);
	if (!entry) {
		try {
			const ctx = new AudioContext();
			const source = ctx.createMediaElementSource(el);
			const panner = ctx.createStereoPanner();
			const gain = ctx.createGain();
			source.connect(panner);
			panner.connect(gain);
			gain.connect(ctx.destination);
			entry = { ctx, source, panner, gain };
		} catch {
			return null;
		}
		entry.gain.gain.value = desiredVolume.get(el) ?? 1;
		entry.panner.pan.value = desiredPan.get(el) ?? 0;
		captured.set(el, entry);
		// Track the suspended state via statechange, not just a creation-time
		// snapshot: Safari can report a fresh context as running and only settle
		// on suspended later (and a tab-hide suspension should also re-arm the
		// gesture listeners).
		const ctx = entry.ctx;
		const syncBlocked = () => {
			if (ctx.state === "suspended") {
				awaitingGesture.add(ctx);
				markAudioBlocked(ctx);
			} else {
				releaseContext(ctx);
			}
		};
		ctx.addEventListener?.("statechange", syncBlocked);
		syncBlocked();
	}
	return entry;
}

/**
 * Record the volume `el` should play at (0..1; 0 = silenced) and, if it is
 * (or later becomes) captured, enforce it in-graph. Gain does not affect
 * autoplay permission, so unlike el.muted this needs no autoplay-unlock
 * gating.
 */
export function setAudioLevel(el: HTMLAudioElement, volume: number): void {
	desiredVolume.set(el, volume);
	const entry = captured.get(el);
	if (entry) entry.gain.gain.value = volume;
}

/**
 * Record the stereo position `el` should play at (-1 full left .. 0 center ..
 * 1 full right) and, if it is (or later becomes) captured, apply it in-graph.
 * Mirrors {@link setAudioLevel} exactly: safe to call on an element that has
 * never been captured (it just remembers the value for when it is), and
 * writes straight to the live `StereoPannerNode` — no gesture gating, the same
 * as gain — when it already has been.
 */
export function setAudioPan(el: HTMLAudioElement, value: number): void {
	desiredPan.set(el, value);
	const entry = captured.get(el);
	if (entry) entry.panner.pan.value = value;
}

