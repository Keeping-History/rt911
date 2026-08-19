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
// its position with positionMs(), moves it with seekTo(), and re-renders through
// subscribe(); it never creates or destroys one. Removing an entry is release()
// — an explicit, deliberate act by whoever decides an item has left the app, not
// a side effect of rendering.
//
// The second thing this module owns is the PLAYHEAD, which is not the same as an
// element's position and is the reason positionMs answers for items with no
// element at all. Most cards on screen have none — an UPCOMING clip has not
// started, a PREVIOUS one is over, a LIVE one the listener stopped has been
// released — and a card is showing "where is this clip right now", which the
// virtual clock can answer whether or not anything is playing. So a card follows
// the clock until the listener says otherwise, by scrubbing it or by stopping
// it; `followsClock` is that one question and every consumer asks it.
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
	 * the clock", so the reseek, the health check, the gesture retry and the
	 * clock-following playhead all leave it where it is. That is how a
	 * listener-started back-catalogue clip — which plays from its own start, not
	 * from the virtual clock's position — opts out without a second registry or a
	 * flag on ensure(). It is one of the two inputs to `followsClock`; the other
	 * is the listener scrubbing or pausing a card, which this app cannot answer
	 * for because the coordinator performed it.
	 *
	 * It is NOT a way to opt out of the autoplay unlock: an element the browser
	 * refused is retried on a gesture whatever this returns, because the token it
	 * holds is what the "click anywhere to start audio" overlay is showing. See
	 * retryBlockedPlayback.
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
	/**
	 * This element is holding an audioBlocked token.
	 *
	 * The shared store answers "is ANYTHING waiting for a gesture?", which is all
	 * the overlay needs; the gesture retry needs the other half of the question —
	 * WHICH elements are waiting — and an element being `paused` is not that
	 * answer (the listener pauses elements too). Kept in step with the store by
	 * block()/unblock(), which are the only callers of mark/clearAudioBlocked.
	 */
	blocked: boolean;
}

const registry = new Map<number, Entry>();
const listeners = new Map<number, Set<() => void>>();

/**
 * Each watched item's playhead, sampled at the last notify.
 *
 * Cached rather than computed live, because `positionMs` is a
 * `useSyncExternalStore` getSnapshot and that contract requires the same value
 * between notifications. Reading `el.currentTime` — or the clock — fresh on
 * each call breaks it: both advance in real time, so two calls in one render
 * pass return different numbers, React concludes the store changed again, and
 * re-renders — forever. That is the "getSnapshot should be cached to avoid an
 * infinite loop" warning, followed by "Maximum update depth exceeded" once a
 * card is on screen.
 *
 * Sampling on notify instead means the value changes only when we say it does,
 * which is exactly the set of moments we already announce.
 *
 * Keyed by item id rather than held on Entry, because most cards have no
 * element: an UPCOMING clip has not started, a PREVIOUS one is over, a LIVE one
 * the listener stopped has been released. Those cards still have a playhead —
 * it is where the clock says the clip is — and it used to read zero forever.
 */
const positions = new Map<number, number>();

/**
 * Items the listener has positioned by hand, and which therefore no longer
 * track the virtual clock.
 *
 * This is the coordinator's half of one predicate, not a second one — see
 * {@link followsClock}. `ClockSource.itemFor` already says "the app does not
 * want this element following the clock", but the app cannot answer for a scrub
 * the coordinator itself performed without the coordinator calling back into
 * React state on every drag frame. So the app contributes `itemFor` and this
 * module contributes this set, and every caller asks the same question once.
 */
const unfollowed = new Set<number>();

let clock: ClockSource | null = null;
let prevNowMs = 0;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Does `itemId` still take its position from the virtual clock?
 *
 * The single predicate behind the reseek, the drift health check, the gesture
 * retry and the clock-following playhead. Two sources say no: the app (a
 * listener-started back-catalogue clip plays from its own start, so its
 * `itemFor` returns undefined) and this module (the listener scrubbed or paused
 * this card). They mean the same thing, so they are asked together.
 */
function followsClock(itemId: number): boolean {
	if (unfollowed.has(itemId)) return false;
	return clock?.itemFor(itemId) !== undefined;
}

/**
 * Where `itemId`'s playhead is, right now. Three answers, in order:
 *
 *   a registered element   where the element actually is. A playing clip drifts
 *                          from the clock, and that gap IS the drift badge, so
 *                          the element wins wherever there is one to ask.
 *   a watched, following   where the clock says the clip is. This is the answer
 *   card                   for every card with no element of its own.
 *   anything else          whatever was last recorded — a playhead the listener
 *                          parked — or nothing at all.
 *
 * "Watched" (something subscribed) rather than "known" is what bounds the
 * cache: the coordinator keeps a playhead for the cards on screen and the
 * elements it owns, not for all 814 items in the catalogue.
 */
function samplePosition(itemId: number): number | undefined {
	const entry = registry.get(itemId);
	if (entry) return entry.el.currentTime * 1000;
	if (!listeners.has(itemId)) return undefined;
	const item = followsClock(itemId) ? clock?.itemFor(itemId) : undefined;
	if (!clock || !item) return positions.get(itemId);
	return calcSeekSeconds(item, clock.nowMs()) * 1000;
}

function notify(itemId: number): void {
	// Sample the position as part of notifying, so the snapshot and the
	// notification can never disagree: every path that tells React "this item
	// changed" refreshes the value React is about to read.
	const next = samplePosition(itemId);
	if (next === undefined) positions.delete(itemId);
	else positions.set(itemId, next);
	const subscribers = listeners.get(itemId);
	if (!subscribers) return;
	for (const cb of subscribers) cb();
}

/**
 * Mark this element as waiting for a user gesture, in both places that have to
 * agree about it. The element itself is the token — unique per element and
 * impossible to collide with another module's.
 */
function block(entry: Entry): void {
	entry.blocked = true;
	markAudioBlocked(entry.el);
}

/** The inverse of {@link block}; safe to call on an element that was never blocked. */
function unblock(entry: Entry): void {
	entry.blocked = false;
	clearAudioBlocked(entry.el);
}

/**
 * Every play() goes through here so the shared audioBlocked signal tracks which
 * elements the autoplay policy is holding back: a NotAllowedError means a user
 * gesture will fix it (the overlay tells the user to click); any success clears
 * the element's token.
 */
function tryPlay(itemId: number, entry: Entry): void {
	entry.el
		.play()
		.then(() => {
			unblock(entry);
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
				block(entry);
			}
		});
}

/**
 * Put an element where the virtual clock says it should be — unless it has
 * stopped following the clock, in which case where it is IS where it should be.
 */
function seekToClock(itemId: number, entry: Entry): void {
	const item = followsClock(itemId) ? clock?.itemFor(itemId) : undefined;
	if (!clock || !item) return;
	entry.el.currentTime = calcSeekSeconds(item, clock.nowMs());
	// Notify here rather than leaving it to each caller. A seek moves the
	// position, and the cached snapshot must move with it — the browser will
	// send timeupdate eventually, but "eventually" is up to a quarter second of
	// a card reading a position it has already left. One caller already
	// notified; the jump reseek did not, so a Time Machine scrub left the badge
	// showing the pre-seek position until playback happened to tick.
	notify(itemId);
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
		const current = registry.get(itemId);
		if (current?.el !== el) return;
		if (clock?.clockPaused() || el.ended) return;
		block(current);
		notify(itemId);
	};

	const entry: Entry = {
		el,
		url,
		onPause,
		audible: true,
		unlocked: false,
		blocked: false,
	};
	// Creating an element is the listener handing the clip back to the clock —
	// pressing play on a card they had stopped, or the shell bringing a new LIVE
	// item in. Deliberately in the creation path only: `ensure` is called for
	// every LIVE item on every lane change, so clearing the opt-out on the
	// idempotent path would let a scrub survive about a second.
	unfollowed.delete(itemId);
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
	unblock(entry);
	notify(itemId);
}

/** Stop and forget everything — the app unmounting, or a test resetting. */
export function releaseAll(): void {
	for (const itemId of [...registry.keys()]) release(itemId);
	// The cards are going with the app, so the playheads they parked go too.
	positions.clear();
	unfollowed.clear();
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

/**
 * Where `itemId`'s playhead is: its element's position if it has one, the
 * clock's if it is following, whatever it was parked at if it is not — and
 * undefined for an item nothing owns and nothing is watching.
 */
export function positionMs(itemId: number): number | undefined {
	// The cached sample, NOT a live read of el.currentTime or of the clock — see
	// `positions`. This is a useSyncExternalStore getSnapshot; returning a fresh
	// reading each call makes React re-render without end.
	return positions.get(itemId);
}

/**
 * Move `itemId`'s playhead to `ms` and take it off clock-follow.
 *
 * The only way a card is allowed to seek. Writing `el.currentTime` from a card
 * would move the audio and leave the cached snapshot — which is what every
 * reader, including that card's own badge and transcript, is looking at —
 * showing a position the clip has already left. Going through here moves both
 * in the same step.
 *
 * A card with no element is seekable too: it has a playhead precisely because
 * the clock gives it one, and the listener dragging it is the moment they take
 * it back.
 */
export function seekTo(itemId: number, ms: number): void {
	// The element ignores a negative currentTime; the parked value would keep it.
	const at = Math.max(0, ms);
	unfollowed.add(itemId);
	const entry = registry.get(itemId);
	if (entry) entry.el.currentTime = at / 1000;
	else if (listeners.has(itemId)) positions.set(itemId, at);
	notify(itemId);
}

/**
 * Take `itemId` off clock-follow without moving it — the listener stopped this
 * card, and a stopped card's playhead stays where they stopped it rather than
 * running on ahead of the silence.
 *
 * Called BEFORE the shell releases the element, so the position being frozen is
 * the one the element had reached.
 */
export function unfollowClock(itemId: number): void {
	unfollowed.add(itemId);
	notify(itemId);
}

/**
 * Watch one item's playhead. Shaped for `useSyncExternalStore` alongside
 * `positionMs`, whose number snapshot is stable by value.
 */
export function subscribe(itemId: number, cb: () => void): () => void {
	let subscribers = listeners.get(itemId);
	if (!subscribers) {
		subscribers = new Set();
		listeners.set(itemId, subscribers);
	}
	subscribers.add(cb);
	// Prime the snapshot rather than leaving it undefined until something
	// happens: React reads getSnapshot immediately after subscribing, and a
	// clock-following card with no element has no media event to sample on — its
	// first reading would otherwise be "no position" for up to a second.
	const primed = samplePosition(itemId);
	if (primed === undefined) positions.delete(itemId);
	else positions.set(itemId, primed);
	return () => {
		subscribers.delete(cb);
		if (subscribers.size > 0) return;
		listeners.delete(itemId);
		// Nothing is watching and nothing owns it, so the cached playhead left
		// with the card that was reading it — it costs nothing to re-derive from
		// the clock when a card comes back.
		//
		// Two things deliberately survive. A registered element keeps its
		// position, because that position outlives the card that rendered it,
		// which is the whole reason the registry exists. And a card the listener
		// scrubbed or paused keeps BOTH its parked position and its opt-out, for
		// the same reason: a tag filter toggling is not the listener changing
		// their mind, and re-checking that filter must not hand the card back to
		// the clock they took it off.
		if (!registry.has(itemId) && !unfollowed.has(itemId)) positions.delete(itemId);
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
		const item = followsClock(itemId) ? clock.itemFor(itemId) : undefined;
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
 * Report that the virtual clock moved — the app's once-a-second tick.
 *
 * Two different jobs, and only one of them used to happen. A jump larger than
 * JUMP_THRESHOLD_MS is a scrub and reseeks every registered element; ordinary
 * per-second advance leaves those elements alone so it never fights their own
 * playback. But an advance of any size is the ONLY thing that moves the
 * playhead of a card with no element — an UPCOMING clip, a PREVIOUS one, a LIVE
 * one the listener stopped — so those are resampled on every tick. Returning
 * early on a small delta is what used to leave them frozen at zero.
 */
export function clockMoved(): void {
	if (!clock) return;
	const now = clock.nowMs();
	const delta = now - prevNowMs;
	prevNowMs = now;
	const jumped = Math.abs(delta) > JUMP_THRESHOLD_MS;
	// Registered elements plus rendered cards: the union is exactly the set of
	// items something is showing or something is playing.
	for (const itemId of new Set([...registry.keys(), ...listeners.keys()])) {
		if (!followsClock(itemId)) continue;
		const entry = registry.get(itemId);
		if (!entry) notify(itemId);
		else if (jumped) seekToClock(itemId, entry);
	}
}

/**
 * A user gesture is the first moment blocked playback can start: Safari refuses
 * gesture-less play() on page load, so a restored session autoplays into a
 * blocked state, and nothing in the card grid necessarily changes React state
 * to retry it. Any click or keypress retries immediately.
 *
 * Two different questions are asked here, and conflating them is what used to
 * leave the "click anywhere to start audio" overlay stuck forever:
 *
 *   BLOCKED       the element is holding a token, so the overlay is up because
 *                 of it, only a resolved play() can clear that token, and only
 *                 a gesture can make that play() resolve. Retried
 *                 unconditionally — whether the clock claims the element is
 *                 beside the point, because the listener is being told to click
 *                 and the click has to mean something.
 *   MERELY PAUSED nothing is waiting on a gesture; the element is stopped. Here
 *                 clock-follow is the right test, and it is the health check's
 *                 test too: a listener who paused a back-catalogue clip, or
 *                 scrubbed a card to where they wanted it, must not have that
 *                 undone by their next click anywhere on the desktop.
 *
 * The elements that do not follow the clock are exactly the ones the old test
 * threw away: a listener-started PREVIOUS clip (`itemFor` returns undefined for
 * it by design), a card the listener has scrubbed, and a LIVE card whose item
 * reached the lane through the history snapshot or the reveal buffer rather than
 * through the live mp3 set. Any of them could take a token to the grave, and no
 * amount of clicking would clear it.
 */
function retryBlockedPlayback(): void {
	if (!clock || clock.clockPaused()) return;
	for (const [itemId, entry] of registry) {
		if (entry.blocked) {
			tryPlay(itemId, entry);
			continue;
		}
		if (!followsClock(itemId)) continue;
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
