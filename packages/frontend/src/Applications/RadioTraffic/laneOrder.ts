// Where the listener has dragged cards to, per lane.
//
// Pure module, no React. The whole of Radio Traffic's manual ordering is three
// ideas, and all three are here so a test can drive them without rendering:
//
//   1. Order is SPARSE. A lane is chronological until the listener drags
//      something; a drag records one pin, and every card they never touched
//      keeps its chronological place relative to the others. There is no
//      "current order" array to keep in step with the stream — the stream is
//      the order, and pins are the few exceptions to it.
//
//   2. A pin names a SLOT, not a rank. "Third from the top" is what a drag
//      means, and a model that could only express "near the front" would make
//      dragging a card down one place move it to the top instead.
//
//   3. A pin is scoped to (lane, itemId) and DIES when the item changes lane.
//      This is the subtle one — see reconcileLaneOrder.
//
// Wire shape: a lane's pins are a flat (itemId, slot) pair list, so the whole
// structure is plain numbers that round-trip through Classicy app state and
// JSON with no revivers. `[3, 0, 1, 2]` reads "item 3 to slot 0, item 1 to
// slot 2".

import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { startMs } from "../radio-core/stationGrouping";
import { type Lane, laneFor } from "./cardStatus";

/** Every lane, in the order they stack down the window. */
export const LANES: readonly Lane[] = ["live", "upcoming", "previous"];

/** One lane's pins: a flat (itemId, slot) pair list. */
export type LanePins = readonly number[];

export type LaneOrder = Readonly<Record<Lane, LanePins>>;

export const EMPTY_LANE_ORDER: LaneOrder = { live: [], upcoming: [], previous: [] };

interface Pin {
	id: number;
	slot: number;
}

/**
 * Read the pair list. A trailing id with no slot is dropped rather than read as
 * slot `undefined` — persisted state is untrusted here the same way
 * radioPlayback's sanitizeItemIds treats it, and half a pin is not an
 * instruction.
 */
function readPins(order: LanePins): Pin[] {
	const pins: Pin[] = [];
	for (let i = 0; i + 1 < order.length; i += 2) {
		const id = order[i];
		const slot = order[i + 1];
		if (!Number.isFinite(id) || !Number.isFinite(slot)) continue;
		pins.push({ id, slot });
	}
	return pins;
}

/**
 * The lane's items in the order it renders them.
 *
 * Unpinned items are laid out first, in the chronological order they arrived
 * in, and each pinned item is then INSERTED at its slot. Insertion rather than
 * slot-claiming is what makes this total: there are no collisions to resolve
 * and no holes to fill, so every pin list — including a stale or hand-edited
 * one — describes exactly one arrangement.
 *
 * Pins are applied lowest slot first so that each insertion lands before the
 * ones after it have shifted anything. Two pins on the same slot go to the one
 * recorded LAST, because moveWithinLane appends: the listener's most recent
 * drag is the one they are watching.
 */
export function applyManualOrder(items: readonly MediaItem[], order: LanePins): MediaItem[] {
	const pins = readPins(order);
	if (pins.length === 0) return [...items];

	const byId = new Map(items.map((item) => [item.id, item] as const));
	// A pin can name an item that is not in this lane — the clock moves items
	// between lanes on a tick that persisted state has not been reconciled
	// against yet. Rendering must not invent a card for it.
	const present = pins.filter((pin) => byId.has(pin.id));
	if (present.length === 0) return [...items];

	const pinnedIds = new Set(present.map((pin) => pin.id));
	const result = items.filter((item) => !pinnedIds.has(item.id));

	// Stable sort, so equal slots keep their appearance order and the last one
	// inserted ends up on top.
	for (const pin of [...present].sort((a, b) => a.slot - b.slot)) {
		const item = byId.get(pin.id);
		if (!item) continue;
		// A slot recorded when the lane was longer still says "put it last", and a
		// negative one says "put it first"; neither is a reason to drop the card.
		const at = Math.max(0, Math.min(pin.slot, result.length));
		result.splice(at, 0, item);
	}
	return result;
}

/**
 * Pin `fromId` to `toIndex`, dropping whatever pin it had before.
 *
 * Only the dragged id is recorded. The cards it displaces are NOT pinned — that
 * is what keeps the map sparse, and it is why a card the listener never touched
 * goes back to following the clock the moment the drag stops mattering.
 *
 * The new pin is appended so it wins a contested slot (see applyManualOrder).
 */
export function moveWithinLane(order: LanePins, fromId: number, toIndex: number): number[] {
	const kept = readPins(order).filter((pin) => pin.id !== fromId);
	const slot = Math.max(0, Math.trunc(toIndex));
	return [...kept.flatMap((pin) => [pin.id, pin.slot]), fromId, slot];
}

/** Which lane each item is in at `nowMs`, by item id. */
export function laneMembership(items: readonly MediaItem[], nowMs: number): Map<number, Lane> {
	return new Map(items.map((item) => [item.id, laneFor(item, nowMs)] as const));
}

/**
 * Drop every pin that has stopped meaning anything, and only those.
 *
 * A pin is a position relative to a SIBLING SET, and the sibling set is the
 * lane. The clock changes lane membership constantly — forwards as clips start
 * and end, backwards whenever the listener seeks — so a pin made in UPCOMING is
 * describing a set the item is no longer in the moment it goes LIVE. Carrying
 * it over would let a drag the listener made minutes ago silently reorder a
 * lane they never touched, and the position it asked for would be measured
 * against different neighbours than the ones they were looking at.
 *
 * The pin is dropped, not migrated: the honest answer to "where in LIVE does
 * this card go" is "wherever the clock puts it", because the listener has not
 * said.
 *
 * The same pass is what bounds the map. Anything absent from `membership` is in
 * no lane at all — retired by a backward seek or by retention pruning — and
 * goes too. Without this the map only ever grows: a long session with seeks
 * accumulates ids for items that left the app entirely. Same intent as
 * radio-core/radioPlayback's sanitizeItemIds, applied to the live item set
 * rather than to the value's shape.
 *
 * Returns the input object untouched when nothing was dropped — this runs on
 * every tick, and a fresh object would re-render all three lanes for nothing.
 */
export function reconcileLaneOrder(
	order: LaneOrder,
	membership: ReadonlyMap<number, Lane>,
): LaneOrder {
	const next: Record<Lane, LanePins> = { ...order };
	let changed = false;

	for (const lane of LANES) {
		const pins = readPins(order[lane]);
		const kept = pins.filter((pin) => membership.get(pin.id) === lane);
		if (kept.length === pins.length && order[lane].length === pins.length * 2) continue;
		next[lane] = kept.flatMap((pin) => [pin.id, pin.slot]);
		changed = true;
	}

	return changed ? next : order;
}

/**
 * The single write path for manual order: pin the dragged card, then reconcile.
 *
 * Both halves are here so neither can be forgotten. Pruning on write is the
 * bound on the map's size, and reconciling on write is also what enforces "a
 * card cannot be dragged across lanes" at the data layer — a pin asked for in a
 * lane the item is not in is pruned straight back out, so even a caller that
 * gets it wrong cannot persist one.
 */
export function reorderLane(
	order: LaneOrder,
	lane: Lane,
	fromId: number,
	toIndex: number,
	membership: ReadonlyMap<number, Lane>,
): LaneOrder {
	const moved: LaneOrder = { ...order, [lane]: moveWithinLane(order[lane], fromId, toIndex) };
	return reconcileLaneOrder(moved, membership);
}

/**
 * The render order after two AUTOMATIC rules layered on top of
 * {@link applyManualOrder} — not a replacement for it. A drag pin still names
 * where a card sits among its lane's own siblings; what this function decides
 * is what happens to that arrangement from one tick to the next as the SET of
 * siblings changes, which a pin says nothing about.
 *
 *   1. NEW ARRIVAL. Any id in `items` that `previousIds` has never rendered is
 *      genuinely new this tick — a clip that just went live, just ended into
 *      PREVIOUS, or just entered the UPCOMING window — and moves to the very
 *      front, newest `start_date` first, ahead of everything the lane already
 *      had. Every id `previousIds` already knows about keeps whatever
 *      relative order `items` gave it, untouched — so a manual pin (or plain
 *      chronological order) among already-seen cards survives.
 *
 *   2. ACTIVE LOCK. `activeId` is the one card that must not appear to move —
 *      the shell's notion of "highlighted or playing" (see LaneSection's
 *      `activeId` prop). If it rendered last tick, rule 1 may have pushed it
 *      right by however many new arrivals just landed ahead of it; this
 *      splices it back to the exact index it held before, so the listener's
 *      eye finds it in the same place no matter how much else changed. Only
 *      that one id is touched — every OTHER card still reflows normally.
 *
 * `previousIds` being `undefined` means this is the lane's first-ever render,
 * or the caller simply has nothing to compare against — there is no "before"
 * to hold anything stable relative to, and calling every item "new" would
 * reorder a lane that has not actually changed. So this is a passthrough: the
 * order `items` already has is returned exactly as given.
 */
export function stabilizeLaneOrder(
	items: readonly MediaItem[],
	previousIds: readonly number[] | undefined,
	activeId: number | null,
): MediaItem[] {
	if (previousIds === undefined) return [...items];

	const previousIndex = new Map(previousIds.map((id, i) => [id, i] as const));
	const seen: MediaItem[] = [];
	const fresh: MediaItem[] = [];
	for (const item of items) {
		(previousIndex.has(item.id) ? seen : fresh).push(item);
	}
	// Newest first among the arrivals themselves, whichever direction the
	// caller's own chronological order happens to run — several clips can go
	// live in the same tick, and the criterion is the clock, not the caller's
	// sort.
	fresh.sort((a, b) => startMs(b) - startMs(a));

	const result = [...fresh, ...seen];
	if (activeId === null) return result;

	const activeWas = previousIndex.get(activeId);
	// Not rendered last tick — nothing to hold it stable relative to. A card
	// that only became active this same tick has no "before" position for a
	// jump to be measured against.
	if (activeWas === undefined) return result;

	const activeNow = result.findIndex((item) => item.id === activeId);
	// Left the lane entirely, or never moved — either way there is nothing to
	// splice back.
	if (activeNow === -1 || activeNow === activeWas) return result;

	const [active] = result.splice(activeNow, 1);
	result.splice(Math.min(activeWas, result.length), 0, active);
	return result;
}
