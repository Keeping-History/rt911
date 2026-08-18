import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { Lane } from "./cardStatus";
import {
	applyManualOrder,
	EMPTY_LANE_ORDER,
	laneMembership,
	moveWithinLane,
	reconcileLaneOrder,
	reorderLane,
} from "./laneOrder";
import { makeItem } from "./tabs/cardTabFixtures";

/**
 * A clip that starts at `startUtc` and runs `durationSec`. The default is short
 * enough that the four fixture clips below do not overlap, so "the lane each
 * item is in" has one obvious answer at any instant.
 */
function clip(id: number, startUtc: string, durationSec = 50): MediaItem {
	const start = Date.parse(`${startUtc}Z`);
	const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
	return makeItem({
		id,
		title: `ZBW-${id}`,
		source: `ATC-${id}`,
		start_date: iso(start),
		end_date: iso(start + durationSec * 1000),
	});
}

const ids = (items: readonly MediaItem[]) => items.map((i) => i.id);

/** Four clips, chronological, ids 1..4 — the incoming order every case starts from. */
const A = clip(1, "2001-09-11T12:46:31");
const B = clip(2, "2001-09-11T12:47:31");
const C = clip(3, "2001-09-11T12:48:31");
const D = clip(4, "2001-09-11T12:49:31");
const LANE_ITEMS = [A, B, C, D];

describe("applyManualOrder", () => {
	it("leaves an unpinned lane exactly chronological", () => {
		expect(ids(applyManualOrder(LANE_ITEMS, []))).toEqual([1, 2, 3, 4]);
	});

	it("puts a card pinned to slot 0 at the top", () => {
		// (id 3, slot 0)
		expect(ids(applyManualOrder(LANE_ITEMS, [3, 0]))).toEqual([3, 1, 2, 4]);
	});

	it("puts a card pinned to a middle slot at exactly that index", () => {
		// The load-bearing property: a pin names a SLOT, not "somewhere near the
		// front". Dragging a card down one place has to actually move it down one
		// place, which a front-of-list model cannot express.
		expect(ids(applyManualOrder(LANE_ITEMS, [1, 2]))).toEqual([2, 3, 1, 4]);
	});

	it("keeps every unpinned card in chronological order around the pins", () => {
		// Criterion: manual order is sparse. Only ids 1 and 3 are named; 2 and 4
		// are never mentioned and stay in their original relative sequence.
		const result = ids(applyManualOrder(LANE_ITEMS, [3, 0, 1, 3]));
		expect(result).toEqual([3, 2, 4, 1]);
		expect(result.filter((id) => id === 2 || id === 4)).toEqual([2, 4]);
	});

	it("honours several pins at once, each at its own slot", () => {
		expect(ids(applyManualOrder(LANE_ITEMS, [1, 2, 3, 0]))).toEqual([3, 2, 1, 4]);
	});

	it("gives a contested slot to the pin made last", () => {
		// Two cards dragged to the top in turn: the second drag wins, which is what
		// the listener just did. Deterministic either way, but this is the one that
		// matches the gesture.
		expect(ids(applyManualOrder(LANE_ITEMS, [1, 0, 2, 0]))).toEqual([2, 1, 3, 4]);
	});

	it("ignores a pin for an id that is not in the lane", () => {
		// A pin can outlive its item by one render — the clock moves items between
		// lanes on a tick that the persisted order has not been reconciled against
		// yet. Rendering must not blow up or invent a card.
		expect(ids(applyManualOrder(LANE_ITEMS, [99, 0]))).toEqual([1, 2, 3, 4]);
	});

	it("clamps a pin past the end of the lane to the end", () => {
		// The lane shrinks as items age out; a slot recorded when it was longer is
		// still a real instruction ("put it last"), not a reason to drop the card.
		expect(ids(applyManualOrder(LANE_ITEMS, [1, 40]))).toEqual([2, 3, 4, 1]);
	});

	it("treats a negative slot as the top", () => {
		expect(ids(applyManualOrder(LANE_ITEMS, [4, -3]))).toEqual([4, 1, 2, 3]);
	});

	it("ignores a trailing id with no slot", () => {
		// Malformed persisted state: an odd-length pair list. Read what parses.
		expect(ids(applyManualOrder(LANE_ITEMS, [3, 0, 1]))).toEqual([3, 1, 2, 4]);
	});

	it("does not mutate the items it was given", () => {
		const items = [...LANE_ITEMS];
		applyManualOrder(items, [4, 0]);
		expect(ids(items)).toEqual([1, 2, 3, 4]);
	});

	it("returns an empty lane unchanged", () => {
		expect(applyManualOrder([], [1, 0])).toEqual([]);
	});
});

describe("moveWithinLane", () => {
	it("pins a card that had no pin yet", () => {
		expect(moveWithinLane([], 3, 2)).toEqual([3, 2]);
	});

	it("replaces a card's earlier pin rather than adding a second", () => {
		// Two pins for one id would be two answers about where it goes.
		expect(moveWithinLane([3, 2], 3, 0)).toEqual([3, 0]);
	});

	it("leaves other cards' pins alone", () => {
		expect(moveWithinLane([1, 0, 3, 2], 3, 1)).toEqual([1, 0, 3, 1]);
	});

	it("records the newest pin last so it wins a contested slot", () => {
		expect(moveWithinLane([1, 0], 2, 0)).toEqual([1, 0, 2, 0]);
	});

	it("clamps a negative target to the top", () => {
		expect(moveWithinLane([], 3, -1)).toEqual([3, 0]);
	});

	it("does not mutate the order it was given", () => {
		const order = [1, 0];
		moveWithinLane(order, 2, 1);
		expect(order).toEqual([1, 0]);
	});

	it("pins only the dragged id, never the cards it displaced", () => {
		// Criterion: the map stays sparse. One drag, one entry.
		const after = moveWithinLane([], 2, 3);
		expect(after).toHaveLength(2);
		expect(after[0]).toBe(2);
	});
});

describe("laneMembership", () => {
	it("reports the lane each item is in at the given instant", () => {
		// B is mid-clip at 12:48:00; A has ended; C and D have not started.
		const at = Date.parse("2001-09-11T12:48:00Z");
		const membership = laneMembership(LANE_ITEMS, at);
		expect(membership.get(1)).toBe<Lane>("previous");
		expect(membership.get(2)).toBe<Lane>("live");
		expect(membership.get(3)).toBe<Lane>("upcoming");
		expect(membership.get(4)).toBe<Lane>("upcoming");
	});
});

describe("reconcileLaneOrder", () => {
	const membership = new Map<number, Lane>([
		[1, "live"],
		[2, "upcoming"],
	]);

	it("keeps a pin whose item is still in the lane that holds it", () => {
		const order = { ...EMPTY_LANE_ORDER, live: [1, 0] };
		expect(reconcileLaneOrder(order, membership)).toEqual({
			live: [1, 0],
			upcoming: [],
			previous: [],
		});
	});

	it("drops a pin for an item that has changed lane", () => {
		// Item 2 is pinned in LIVE but the clock now puts it in UPCOMING. The pin
		// described a position among LIVE's siblings, and that sibling set no
		// longer contains it — there is nothing left for it to mean.
		const order = { ...EMPTY_LANE_ORDER, live: [1, 0, 2, 1] };
		expect(reconcileLaneOrder(order, membership).live).toEqual([1, 0]);
	});

	it("does not move a dropped pin into the item's new lane", () => {
		// Silently re-pinning would reorder a lane the listener never touched.
		const order = { ...EMPTY_LANE_ORDER, live: [2, 0] };
		const after = reconcileLaneOrder(order, membership);
		expect(after.live).toEqual([]);
		expect(after.upcoming).toEqual([]);
	});

	it("drops a pin for an item that is in no lane at all", () => {
		// Backward seeks and retention pruning both retire items outright. This is
		// the growth the pin map would otherwise never shed.
		const order = { ...EMPTY_LANE_ORDER, previous: [77, 0] };
		expect(reconcileLaneOrder(order, membership).previous).toEqual([]);
	});

	it("returns the same object when nothing needed dropping", () => {
		// This runs on every clock tick; a fresh object each time would re-render
		// all three lanes for no reason.
		const order = { ...EMPTY_LANE_ORDER, live: [1, 0] };
		expect(reconcileLaneOrder(order, membership)).toBe(order);
	});
});

describe("reorderLane", () => {
	const membership = new Map<number, Lane>([
		[1, "live"],
		[2, "live"],
		[3, "upcoming"],
	]);

	it("pins the dragged card in its own lane", () => {
		const after = reorderLane(EMPTY_LANE_ORDER, "live", 2, 0, membership);
		expect(after.live).toEqual([2, 0]);
	});

	it("prunes ids that are no longer present, on the write", () => {
		// Criterion: the pin map cannot grow without bound. The single write path
		// prunes, so no caller can forget to.
		const stale = { ...EMPTY_LANE_ORDER, live: [1, 0, 404, 1], previous: [909, 0] };
		const after = reorderLane(stale, "live", 2, 1, membership);
		expect(after.live).toEqual([1, 0, 2, 1]);
		expect(after.previous).toEqual([]);
	});

	it("prunes a pin whose item changed lane, on the write", () => {
		const stale = { ...EMPTY_LANE_ORDER, live: [3, 0] };
		expect(reorderLane(stale, "live", 1, 0, membership).live).toEqual([1, 0]);
	});

	it("cannot pin a card into a lane it is not in", () => {
		// Criterion: a card cannot cross lanes. Even a caller that asks for it gets
		// the pin pruned back out on the same write.
		expect(reorderLane(EMPTY_LANE_ORDER, "previous", 1, 0, membership).previous).toEqual([]);
	});

	it("leaves the other two lanes' pins untouched", () => {
		const order = { ...EMPTY_LANE_ORDER, upcoming: [3, 0] };
		const after = reorderLane(order, "live", 1, 0, membership);
		expect(after.upcoming).toEqual([3, 0]);
	});
});

describe("a manually-reordered card crossing a lane boundary", () => {
	// One clip, one pin, and a clock that walks it across both boundaries and
	// then back. The pin must not survive any crossing: it described a position
	// among the siblings of the lane it was made in.
	//
	// X runs 12:47:31 → 12:49:31, so the three instants below sit one in each
	// lane with room to spare on either side of both boundaries.
	const X = clip(9, "2001-09-11T12:47:31", 120);
	const BEFORE_START = Date.parse("2001-09-11T12:47:00Z");
	const MID_CLIP = Date.parse("2001-09-11T12:48:00Z");
	const AFTER_END = Date.parse("2001-09-11T12:50:00Z");
	const lane = (at: number) => laneMembership([X], at).get(X.id);

	it("walks UPCOMING → LIVE → PREVIOUS as the clock advances", () => {
		expect(lane(BEFORE_START)).toBe<Lane>("upcoming");
		expect(lane(MID_CLIP)).toBe<Lane>("live");
		expect(lane(AFTER_END)).toBe<Lane>("previous");
	});

	it("drops a UPCOMING pin when the clock moves the card forward into LIVE", () => {
		const pinned = reorderLane(EMPTY_LANE_ORDER, "upcoming", X.id, 0, laneMembership([X], BEFORE_START));
		expect(pinned.upcoming).toEqual([X.id, 0]);

		const afterTick = reconcileLaneOrder(pinned, laneMembership([X], MID_CLIP));
		expect(afterTick.upcoming).toEqual([]);
		expect(afterTick.live).toEqual([]);
	});

	it("drops a LIVE pin when the clock moves the card forward into PREVIOUS", () => {
		const pinned = reorderLane(EMPTY_LANE_ORDER, "live", X.id, 0, laneMembership([X], MID_CLIP));
		expect(pinned.live).toEqual([X.id, 0]);

		const afterTick = reconcileLaneOrder(pinned, laneMembership([X], AFTER_END));
		expect(afterTick.live).toEqual([]);
		expect(afterTick.previous).toEqual([]);
	});

	it("drops a PREVIOUS pin when a backward seek moves the card back into LIVE", () => {
		// The reverse direction is not symmetric bookkeeping — retention's leading
		// edge really does hand items back to earlier lanes on a seek, and a pin
		// that survived would reorder LIVE on the listener's behalf.
		const pinned = reorderLane(EMPTY_LANE_ORDER, "previous", X.id, 0, laneMembership([X], AFTER_END));
		expect(pinned.previous).toEqual([X.id, 0]);

		const afterSeek = reconcileLaneOrder(pinned, laneMembership([X], MID_CLIP));
		expect(afterSeek.previous).toEqual([]);
		expect(afterSeek.live).toEqual([]);
	});

	it("drops a LIVE pin when a backward seek moves the card back into UPCOMING", () => {
		const pinned = reorderLane(EMPTY_LANE_ORDER, "live", X.id, 0, laneMembership([X], MID_CLIP));
		const afterSeek = reconcileLaneOrder(pinned, laneMembership([X], BEFORE_START));
		expect(afterSeek.live).toEqual([]);
		expect(afterSeek.upcoming).toEqual([]);
	});

	it("leaves the lane chronological once its pin has been dropped", () => {
		// The whole point, end to end and non-vacuously: the pin really does
		// reorder its lane first, and after the crossing the lane renders exactly
		// as it would have if the listener had never dragged anything.
		const atMid = laneMembership(LANE_ITEMS, MID_CLIP);
		const upcoming = LANE_ITEMS.filter((item) => atMid.get(item.id) === "upcoming");
		expect(ids(upcoming)).toEqual([3, 4]);

		const pinned = reorderLane(EMPTY_LANE_ORDER, "upcoming", 4, 0, atMid);
		expect(ids(applyManualOrder(upcoming, pinned.upcoming))).toEqual([4, 3]);

		// The clock advances past both clips' starts; neither is UPCOMING any more.
		const later = reconcileLaneOrder(pinned, laneMembership(LANE_ITEMS, AFTER_END));
		expect(later.upcoming).toEqual([]);
		expect(ids(applyManualOrder(upcoming, later.upcoming))).toEqual([3, 4]);
	});

	it("does not accumulate pins across a long walk of the clock", () => {
		// Growth check: pin at every step, reconcile at every step, and the map
		// still holds at most the one card that is still where it was pinned.
		let order = EMPTY_LANE_ORDER;
		for (const at of [BEFORE_START, MID_CLIP, AFTER_END, MID_CLIP, BEFORE_START, AFTER_END]) {
			const membership = laneMembership([X], at);
			const currentLane = membership.get(X.id) as Lane;
			order = reorderLane(order, currentLane, X.id, 0, membership);
			const total = order.live.length + order.upcoming.length + order.previous.length;
			expect(total).toBe(2);
		}
	});
});
