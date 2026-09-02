// Issue #564: cap how many LIVE clips may hold an `<audio>` element — and
// therefore a download and a decoder — at once.
//
// This module decides ADMISSION only. It never touches audioCoordinator's
// registry directly: RadioTraffic.tsx's registration effect (the one place
// that already calls ensure()/release() over the FILTER-VISIBLE live lane)
// reads `admitted` off the state this module returns and registers exactly
// those ids, leaving every other desired id unregistered — no element, no
// fetch, no decoder — until a slot frees up. That is the whole of "the number
// of clips should limit audio processing, as well as downloading": a clip
// that never gets an element never costs either.
//
// "Always prefer playing out a radio clip before starting a new one to
// overtake the queue" is `reconcileClipQueue` never evicting an admitted id
// on its own — the only way an id leaves `admitted` is that it stopped being
// desired (it left the LIVE lane, the listener stopped it, or a tag filter
// hid it), which is exactly the shell's existing release() trigger. A newly
// arrived clip goes to the back of `pending` and waits, however long that
// takes, rather than preempting whatever is already playing.
//
// A lowered cap does not evict anything either, for the same reason: it only
// throttles how many NEW ids get pulled off `pending`, so turning the slider
// down mid-session narrows admission going forward without yanking a clip a
// listener is already hearing.
//
// Scoped to the LIVE lane only (robbiebyrd's amendment to the approved plan):
// a back-catalogue clip the listener starts by hand from PREVIOUS bypasses
// this module entirely and is registered unconditionally, the same as before
// this issue — a listener who explicitly reaches for a specific clip should
// not be told to wait behind the live mix.

/** `admitted`'s order IS the queue's memory of arrival — see `admissionSlot`. */
export interface ClipQueueState {
	/** Ids currently allowed an `<audio>` element, oldest-admitted first. */
	admitted: readonly number[];
	/** Ids waiting for a slot, oldest-arrived first. */
	pending: readonly number[];
}

export const EMPTY_CLIP_QUEUE_STATE: ClipQueueState = { admitted: [], pending: [] };

/** Same two lists, whatever order arrived in — the no-op-is-the-same-object check. */
function sameQueueState(a: ClipQueueState, b: ClipQueueState): boolean {
	return (
		a.admitted.length === b.admitted.length &&
		a.pending.length === b.pending.length &&
		a.admitted.every((id, i) => id === b.admitted[i]) &&
		a.pending.every((id, i) => id === b.pending[i])
	);
}

/**
 * Recompute admission for this tick's desired LIVE ids.
 *
 * `desiredIds` is whatever the shell currently wants playing — filter-visible,
 * un-stopped LIVE items, in the order RadioTraffic.tsx already sorts them
 * (earliest start first), which doubles as this queue's arrival order. Three
 * things happen, in order:
 *
 *   1. an id no longer in `desiredIds` drops out of both lists outright — it
 *      left the LIVE lane, a tag filter hid it, or the listener stopped it,
 *      and any of those already tells audioCoordinator to release its
 *      element, so holding a queue slot for it here would be a second,
 *      disagreeing answer to the same question.
 *   2. a brand-new id — not already admitted or pending — joins the back of
 *      `pending`.
 *   3. `pending` is drained onto the back of `admitted` until `maxConcurrent`
 *      is reached or nothing is left waiting.
 *
 * `maxConcurrent` is read fresh every call, so a listener dragging the
 * Settings slider mid-session takes effect on the very next tick — up
 * immediately pulls more off `pending`, down simply admits nothing further
 * until enough already-admitted ids have left `desiredIds` on their own.
 *
 * Returns `state` itself when nothing changed, so a caller storing this in
 * React state does not re-render the whole grid every tick for the common
 * case of "the live mix is exactly what it was a second ago".
 */
export function reconcileClipQueue(
	state: ClipQueueState,
	desiredIds: readonly number[],
	maxConcurrent: number,
): ClipQueueState {
	const desired = new Set(desiredIds);
	const admitted = state.admitted.filter((id) => desired.has(id));
	const pending = state.pending.filter((id) => desired.has(id));

	const known = new Set([...admitted, ...pending]);
	const arrivals = desiredIds.filter((id) => !known.has(id));

	const nextAdmitted = [...admitted];
	const nextPending = [...pending, ...arrivals];
	while (nextAdmitted.length < maxConcurrent && nextPending.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: bounded by the length check above
		nextAdmitted.push(nextPending.shift()!);
	}

	const next: ClipQueueState = { admitted: nextAdmitted, pending: nextPending };
	return sameQueueState(state, next) ? state : next;
}

/**
 * Where `itemId` sits among the currently-admitted ids, or undefined if it
 * holds no slot (it is pending, or not part of this queue at all).
 *
 * The Split feature's whole input: "the first audio player" is slot 0, "the
 * second" is slot 1, and so on, alternating left/right as the caller pans by
 * `index % 2`. Recomputed fresh from `admitted`'s current order rather than
 * latched at the moment an id was admitted, so a slot number — and with it,
 * which side a clip is panned to — can shift when an earlier slot frees up.
 * That is a deliberate reading of "the first … the second … and so on" as a
 * live ordinal among whoever is currently playing, not a permanent seat
 * assigned once and held for the life of the clip.
 */
export function admissionSlot(state: ClipQueueState, itemId: number): number | undefined {
	const index = state.admitted.indexOf(itemId);
	return index === -1 ? undefined : index;
}
