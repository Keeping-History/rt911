// Central ownership of every playing <audio> element in Radio Traffic.
//
// Cards are views, not owners. In the tuner one StationPlayer owned the whole
// audible mix, so element lifetime was effectively app lifetime and a React
// ref map was a fine place to keep the elements. A card grid inverts that:
// cards mount and unmount for reasons that have nothing to do with media — a
// tag filter toggling, a card migrating LIVE→PREVIOUS as the clock advances, a
// drag reorder. If <audio> lifetime followed component lifetime, playback and
// clock sync would be probabilistic: clips would resume from stale assumptions,
// "ended" transitions would be missed while unmounted, and the header badge
// would lose its position reading the moment the element disappeared.
//
// So the elements live here, in a module-level registry keyed by item id, and
// are never in the DOM at all. A card asks for its element with ensure(), reads
// its position with positionMs(), and re-renders through subscribe(); it never
// creates or destroys one. Removing an entry is release() — an explicit,
// deliberate act by whoever decides an item has left the app, not a side effect
// of rendering.
//
// The clock-sync effects that used to iterate StationPlayer's refs (the 15s
// drift health check and the >5s jump reseek) iterate the registry instead, so
// they cover unmounted cards too — which is the entire point. Autoplay retry
// listeners are registered once here rather than once per card.

import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { clearAudioBlocked, markAudioBlocked } from "../radio-core/audioBlocked";
import { calcSeekSeconds } from "../radio-core/stationGrouping";

/** A clock move larger than this is a scrub, not ordinary advance. */
const JUMP_THRESHOLD_MS = 5_000;

const HEALTH_CHECK_INTERVAL_MS = 15_000;

/** Drift the health check tolerates before yanking an element back into sync. */
const DRIFT_TOLERANCE_SECONDS = 30;

/**
 * What the coordinator needs to know from the app shell, read on demand so the
 * registry never holds a stale copy of React state.
 */
export interface ClockSource {
	/** The virtual clock in true UTC ms. */
	nowMs(): number;
	clockPaused(): boolean;
	/**
	 * The item behind a registered id — position maths needs its `start_date`
	 * and `jump`.
	 *
	 * Returning `undefined` is meaningful: it says "this element does not follow
	 * the clock", and the reseek, the health check and the gesture retry all skip
	 * it. That is how a listener-started back-catalogue clip — which plays from
	 * its own start, not from the virtual clock's position — opts out without a
	 * second registry or a flag on ensure().
	 */
	itemFor(itemId: number): MediaItem | undefined;
}

interface Entry {
	el: HTMLAudioElement;
	url: string;
	/** Fires on a pause the coordinator did not initiate. Removed by release(). */
	onPause: () => void;
	/** What the mix wants to hear — see setLevel. */
	audible: boolean;
	/** A play() has resolved, so the autoplay gate is open and `audible` can apply. */
	unlocked: boolean;
}

const registry = new Map<number, Entry>();
const listeners = new Map<number, Set<() => void>>();

let clock: ClockSource | null = null;
let prevNowMs = 0;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

function notify(itemId: number): void {
	const subscribers = listeners.get(itemId);
	if (!subscribers) return;
	for (const cb of subscribers) cb();
}

/**
 * Every play() goes through here so the shared audioBlocked signal tracks which
 * elements the autoplay policy is holding back: a NotAllowedError means a user
 * gesture will fix it (the overlay tells the user to click); any success clears
 * the element's token. The element itself is the token — unique per element and
 * impossible to collide with another module's.
 */
function tryPlay(itemId: number, entry: Entry): void {
	entry.el
		.play()
		.then(() => {
			clearAudioBlocked(entry.el);
			// Past the autoplay gate: an element starts muted because that is what
			// lets the browser permit a gesture-less play(), and only a resolved
			// play() makes it safe to unmute. What it unmutes *to* is the mix's
			// answer, not an unconditional false — otherwise a card the listener
			// silenced would shout the moment a retry succeeded.
			entry.unlocked = true;
			entry.el.muted = !entry.audible;
			notify(itemId);
		})
		.catch((err: unknown) => {
			if ((err as DOMException | null)?.name === "NotAllowedError") {
				markAudioBlocked(entry.el);
			}
		});
}

/** Put an element where the virtual clock says it should be. */
function seekToClock(itemId: number, entry: Entry): void {
	const item = clock?.itemFor(itemId);
	if (!clock || !item) return;
	entry.el.currentTime = calcSeekSeconds(item, clock.nowMs());
}

/**
 * The element for `itemId`, creating and starting it if it is not registered
 * yet. Idempotent: calling it every render is the intended usage, and a card
 * remounting gets back the element that has been playing all along.
 *
 * A changed `url` — the source recording swapped for the enhanced render —
 * re-points the *same* element. audioCapture's createMediaElementSource may be
 * called only once per element and the capture is permanent, so replacing the
 * element would silently orphan the waveform's audio graph.
 *
 * Registering an element means "this should be playing"; the caller decides
 * that, and calls release() when it stops being true.
 */
export function ensure(itemId: number, url: string): HTMLAudioElement {
	const existing = registry.get(itemId);
	if (existing) {
		if (existing.url !== url) {
			existing.url = url;
			existing.el.src = url;
		}
		return existing.el;
	}

	const el = document.createElement("audio");
	el.crossOrigin = "anonymous";
	el.preload = "auto";
	// Start muted so the browser permits autoplay; tryPlay unmutes once play()
	// resolves.
	el.muted = true;
	el.src = url;

	const onPause = () => {
		// A pause we didn't initiate is the autoplay policy speaking — Safari
		// lets a muted play() RESOLVE, then punishes the gesture-less unmute with
		// a silent pause (no rejection anywhere). Our own pauses are excluded:
		// clock pause (guarded here), natural end (el.ended), and release, which
		// removes this listener before pausing.
		if (registry.get(itemId)?.el !== el) return;
		if (clock?.clockPaused() || el.ended) return;
		markAudioBlocked(el);
		notify(itemId);
	};

	const entry: Entry = { el, url, onPause, audible: true, unlocked: false };
	el.addEventListener("pause", onPause);
	el.addEventListener("loadedmetadata", () => {
		seekToClock(itemId, entry);
		notify(itemId);
	});
	el.addEventListener("timeupdate", () => notify(itemId));
	el.addEventListener("play", () => notify(itemId));
	el.addEventListener("ended", () => notify(itemId));

	registry.set(itemId, entry);
	if (!clock?.clockPaused()) tryPlay(itemId, entry);
	notify(itemId);
	return el;
}

/**
 * Stop and forget the element for `itemId`.
 *
 * The pause is the whole point of this function existing, and it must happen
 * before the entry is dropped: these elements are never in the DOM, so once the
 * registry loses the reference nothing anywhere can stop the sound.
 */
export function release(itemId: number): void {
	const entry = registry.get(itemId);
	if (!entry) return;
	// This pause is ours, not the autoplay policy's.
	entry.el.removeEventListener("pause", entry.onPause);
	entry.el.pause();
	registry.delete(itemId);
	// A gone element no longer needs a gesture.
	clearAudioBlocked(entry.el);
	notify(itemId);
}

/** Stop and forget everything — the app unmounting, or a test resetting. */
export function releaseAll(): void {
	for (const itemId of [...registry.keys()]) release(itemId);
}

/**
 * Silence or restore one element without stopping it.
 *
 * The seam between the mix model and the audio hardware: toolMode decides who
 * is audible, this applies the answer. It has to be a coordinator function
 * rather than `el.muted = …` at the call site, because `muted` is already load
 * bearing here — an element starts muted so the autoplay policy permits a
 * gesture-less play(), and tryPlay writes it again on every success. A card
 * setting it directly would either unmute before the gate opens (getting the
 * play() refused) or have its choice overwritten by the next retry.
 *
 * Silence rather than pause, deliberately: a paused element stops advancing and
 * drifts away from the virtual clock, so unmuting it later would drop the
 * listener into a stale offset instead of back into the live mix.
 */
export function setLevel(itemId: number, audible: boolean): void {
	const entry = registry.get(itemId);
	if (!entry || entry.audible === audible) return;
	entry.audible = audible;
	// Before the gate opens the element must stay muted whatever the mix says;
	// tryPlay applies the level the moment play() resolves.
	if (entry.unlocked) entry.el.muted = !audible;
	notify(itemId);
}

/** Where the element for `itemId` actually is, or undefined if not registered. */
export function positionMs(itemId: number): number | undefined {
	const entry = registry.get(itemId);
	return entry ? entry.el.currentTime * 1000 : undefined;
}

/**
 * Watch one item's element. Shaped for `useSyncExternalStore` alongside
 * `positionMs`, whose number snapshot is stable by value.
 */
export function subscribe(itemId: number, cb: () => void): () => void {
	let subscribers = listeners.get(itemId);
	if (!subscribers) {
		subscribers = new Set();
		listeners.set(itemId, subscribers);
	}
	subscribers.add(cb);
	return () => {
		subscribers.delete(cb);
		if (subscribers.size === 0) listeners.delete(itemId);
	};
}

/**
 * Keep every registered element playing and within DRIFT_TOLERANCE_SECONDS of
 * where the clock says it should be. Ported from StationPlayer, iterating the
 * registry instead of one component's refs — an unmounted card's element drifts
 * exactly like a rendered one's, and used to be invisible to this check.
 */
function healthCheck(): void {
	if (!clock || clock.clockPaused()) return;
	const now = clock.nowMs();
	for (const [itemId, entry] of registry) {
		const item = clock.itemFor(itemId);
		if (!item) continue;
		if (entry.el.paused || entry.el.ended) {
			// A late unlock (initial autoplay was blocked; a user gesture has since
			// granted audio) also clears the autoplay mute, or the element resumes
			// playing but stays silent forever.
			tryPlay(itemId, entry);
		}
		const expected = calcSeekSeconds(item, now);
		if (Math.abs(entry.el.currentTime - expected) > DRIFT_TOLERANCE_SECONDS) {
			entry.el.currentTime = expected;
			notify(itemId);
		}
	}
}

/**
 * Install the app's clock and start the drift health check. Returns the
 * disconnect; calling it twice, or after another source has taken over, is a
 * no-op.
 */
export function connectClock(source: ClockSource): () => void {
	clock = source;
	prevNowMs = source.nowMs();
	healthCheckTimer ??= setInterval(healthCheck, HEALTH_CHECK_INTERVAL_MS);
	return () => {
		if (clock !== source) return;
		clock = null;
		if (healthCheckTimer !== null) {
			clearInterval(healthCheckTimer);
			healthCheckTimer = null;
		}
	};
}

/**
 * Report that the virtual clock moved. A jump larger than JUMP_THRESHOLD_MS is
 * a scrub and reseeks every registered element; ordinary per-second advance is
 * left alone so it never fights an element's own playback.
 */
export function clockMoved(): void {
	if (!clock) return;
	const now = clock.nowMs();
	const delta = now - prevNowMs;
	prevNowMs = now;
	if (Math.abs(delta) <= JUMP_THRESHOLD_MS) return;
	for (const [itemId, entry] of registry) {
		if (!clock.itemFor(itemId)) continue;
		seekToClock(itemId, entry);
		notify(itemId);
	}
}

/**
 * A user gesture is the first moment blocked playback can start: Safari refuses
 * gesture-less play() on page load, so a restored session autoplays into a
 * blocked state, and nothing in the card grid necessarily changes React state
 * to retry it. Any click or keypress retries immediately.
 */
function retryBlockedPlayback(): void {
	if (!clock || clock.clockPaused()) return;
	for (const [itemId, entry] of registry) {
		// Same "does this follow the clock?" test the health check makes: a
		// listener who paused a back-catalogue clip must not have it restarted by
		// their next click anywhere on the desktop.
		if (!clock.itemFor(itemId)) continue;
		if (entry.el.paused || entry.el.ended) tryPlay(itemId, entry);
	}
}

// Once for the whole app, not once per card: ten cards each registering three
// document-level capture listeners is thirty handlers firing on every
// interaction. Mirrors audioCapture.ts, which resumes suspended AudioContexts
// from the same gestures.
if (typeof document !== "undefined") {
	document.addEventListener("click", retryBlockedPlayback, true);
	document.addEventListener("keydown", retryBlockedPlayback, true);
	// The mobile click wheel preventDefault()s pointerdown, which suppresses the
	// synthetic click — listen for the pointer event itself as well.
	document.addEventListener("pointerdown", retryBlockedPlayback, true);
}
