// Story 045, revised: keep a LIVE player in the Live lane past its clock
// window once the listener has manually touched it — paused/played it, or
// scrubbed its waveform — until they navigate away from it some other way
// (the app has no explicit "release" gesture; see RadioTraffic.tsx's
// touchedLiveIds comment for how the set is bounded instead).
//
// cardStatus.laneFor is a pure function of the clock, deliberately: it has no
// memory of who is listening, and ten other consumers agree with the window it
// reads. That purity is exactly why it cannot be where this story lives — the
// moment an item's window ends it reports PREVIOUS, full stop, and a listener
// mid-clip would hear the tape cut out from under them with no warning. This
// module is the seam RadioTraffic.tsx's shell already has for reconciling that
// raw, clock-only answer against what the listener has actually done — the
// same seam reconcileSolo (toolMode.ts) and reconcileLaneOrder (laneOrder.ts)
// use for their own pieces of "the clock says X, but the listener said Y".
//
// Untouched is the important half: a card the listener never interacted with
// disappears from LIVE the instant its window ends, same as if this module
// did not exist. Only a touch buys the hold — being merely audible (unmuted,
// unpaused) is no longer enough, and PAUSING a touched card does not release
// it either, because pausing IS a touch.
//
// The memory itself — which ids are currently being held — lives in the
// shell's own React state, one render behind: `nextHeldLiveIds` is asked what
// to hold NEXT, from what is in the LIVE lane THIS render. Keeping that memory
// out of this module is the same reasoning cardStatus.ts's own header gives for
// `previousKind` in badgeFor — a decision hidden in module state would be
// untestable in isolation and would leak an entry per item for the life of the
// app.

import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { Lane } from "./cardStatus";

/**
 * The lane `laneFor` would report, corrected for a manual hold.
 *
 * Only a PREVIOUS verdict is ever overridden. `heldLiveIds` is populated
 * exclusively from items that were already in the LIVE lane (see
 * `nextHeldLiveIds`), so an UPCOMING item can never appear in it — there is
 * nothing to guard against there, but the check is explicit rather than
 * assumed, because a silent LIVE-before-its-start would be a far stranger bug
 * than the one this story fixes.
 */
export function withManualHold(
	rawLane: Lane,
	itemId: number,
	heldLiveIds: ReadonlySet<number>,
): Lane {
	return rawLane === "previous" && heldLiveIds.has(itemId) ? "live" : rawLane;
}

/**
 * Which of this render's LIVE items should still be held come the next one.
 *
 * `liveItems` is the LANE, not the filter-visible subset — the same rule
 * audioCoordinator's element registry follows (element lifetime tracks lane
 * membership, not a tag filter), and for the same reason: a card hidden by a
 * filter can still be the one the listener touched, and a filter toggle must
 * not be what decides whether it survives its clock window.
 *
 * `shouldHold` is the caller's whole answer to "has the listener touched this
 * card" — this module has no business knowing whether that was a pause, a
 * play, or a waveform scrub, only that the shell's `touchedLiveIds` says so.
 */
export function nextHeldLiveIds(
	liveItems: readonly Pick<MediaItem, "id">[],
	shouldHold: (itemId: number) => boolean,
): ReadonlySet<number> {
	const next = new Set<number>();
	for (const item of liveItems) if (shouldHold(item.id)) next.add(item.id);
	return next;
}

/**
 * How long a touch survives with no activity before its hold lapses.
 *
 * A touch is not forever: it is only meant to bridge the gap while the
 * listener is still doing something with the card. `pruneIdleTouches` expects
 * activity to have been re-stamped every tick a card is actually playing, and
 * on every drag frame of a scrub — so this is really how long since the
 * listener last did anything with this card, not how long since they first
 * touched it.
 */
export const IDLE_RELEASE_MS = 10_000;

/**
 * Which touched ids are still fresh enough to keep their hold.
 *
 * `lastActivityMs` is the shell's own record of when each id last did
 * something worth extending the hold for — a press/scrub, or a tick while it
 * was actually playing (see RadioTraffic.tsx). An id with no recorded
 * activity is treated as stale rather than kept: every id that reaches
 * `touchedIds` is stamped at the moment it is added, so a missing entry means
 * the bookkeeping lost it, not that it is still fresh.
 *
 * Returns `touchedIds` itself when nothing was dropped — the same
 * no-op-is-the-same-object discipline `sameIdSet` exists for below.
 */
export function pruneIdleTouches(
	touchedIds: ReadonlySet<number>,
	lastActivityMs: ReadonlyMap<number, number>,
	nowMs: number,
	idleMs: number = IDLE_RELEASE_MS,
): ReadonlySet<number> {
	const next = new Set<number>();
	for (const id of touchedIds) {
		const last = lastActivityMs.get(id);
		if (last !== undefined && nowMs - last < idleMs) next.add(id);
	}
	return next.size === touchedIds.size ? touchedIds : next;
}

/**
 * Same ids, whatever order they arrived in.
 *
 * The shell feeds `nextHeldLiveIds`'s result straight into React state on
 * every render — the LIVE lane is recomputed every tick — so without this a
 * fresh-but-equal Set would fail Object.is and re-render the whole grid once a
 * second even when nothing anyone can hear has changed.
 */
export function sameIdSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}
