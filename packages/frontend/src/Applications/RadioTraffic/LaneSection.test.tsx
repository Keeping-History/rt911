import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { Lane } from "./cardStatus";
import { LANE_LABELS, LaneSection } from "./LaneSection";
import { makeItem } from "./tabs/cardTabFixtures";
import type { Tool } from "./toolMode";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests.
afterEach(cleanup);

const ITEMS = [1, 2, 3].map((id) => makeItem({ id, full_title: `clip ${id}` }));

/** The card stub. LaneSection owns the slot; the shell owns what goes in it. */
const renderCard = (item: MediaItem) => <div data-card={item.id}>{item.full_title}</div>;

function renderLane(
	props: {
		lane?: Lane;
		items?: MediaItem[];
		order?: readonly number[];
		collapsed?: boolean;
		onToggleCollapse?: (collapsed: boolean) => void;
		tool?: Tool;
		onReorder?: (fromId: number, toIndex: number) => void;
	} = {},
) {
	return render(
		<LaneSection
			lane={props.lane ?? "live"}
			items={props.items ?? ITEMS}
			order={props.order}
			collapsed={props.collapsed}
			onToggleCollapse={props.onToggleCollapse}
			tool={props.tool ?? "hand"}
			onReorder={props.onReorder}
			renderCard={renderCard}
		/>,
	);
}

/** The ids of the cards a lane is showing, top to bottom. */
function shownIds(root: ParentNode): number[] {
	return Array.from(root.querySelectorAll("[data-lane-item]")).map((el) =>
		Number(el.getAttribute("data-lane-item")),
	);
}

/**
 * jsdom performs no layout, so every getBoundingClientRect is a zero box and
 * hit-testing a drop target is meaningless without this. Stack each lane's
 * slots vertically at a 130px pitch, offset by `laneTop` so two lanes occupy
 * genuinely different bands of the page.
 */
function stubSlotBoxes(root: ParentNode, laneTop = 0) {
	const cards = root.querySelector("[data-lane-cards]");
	if (!cards) return;
	Array.from(cards.children).forEach((slot, i) => {
		(slot as HTMLElement).getBoundingClientRect = () =>
			({
				left: 0,
				right: 210,
				top: laneTop + i * 130,
				bottom: laneTop + i * 130 + 124,
			}) as DOMRect;
	});
}

/** Centre of the slot at `index`, in the coordinates stubSlotBoxes lays out. */
const slotCentre = (index: number, laneTop = 0) => ({
	clientX: 105,
	clientY: laneTop + index * 130 + 62,
});

/** The centre of an element's (stubbed) box — where a press on it lands. */
function centreOf(el: Element) {
	const box = el.getBoundingClientRect();
	return { clientX: (box.left + box.right) / 2, clientY: (box.top + box.bottom) / 2 };
}

/** A press, a move past the threshold, and a release — the whole gesture. */
function drag(from: Element, to: { clientX: number; clientY: number }) {
	fireEvent.pointerDown(from, { ...centreOf(from), pointerId: 1 });
	fireEvent.pointerMove(from, { ...to, pointerId: 1 });
	fireEvent.pointerUp(from, { ...to, pointerId: 1 });
}

const slot = (root: ParentNode, id: number) =>
	root.querySelector(`[data-lane-item="${id}"]`) as HTMLElement;

describe("LaneSection collapse", () => {
	it("gives LIVE no collapse control", () => {
		// The design has expand/collapse on UPCOMING and PREVIOUS only. LIVE is
		// what the app is for; it does not fold away.
		const { container } = renderLane({ lane: "live" });
		expect(container.querySelector("[data-lane-toggle]")).toBeNull();
	});

	it("gives UPCOMING and PREVIOUS a collapse control", () => {
		for (const lane of ["upcoming", "previous"] as const) {
			cleanup();
			const { container } = renderLane({ lane });
			expect(container.querySelector("[data-lane-toggle]")).not.toBeNull();
		}
	});

	it("hides the cards but keeps the label when collapsed", () => {
		const { container } = renderLane({ lane: "upcoming", collapsed: true });
		expect(container.querySelector("[data-lane-cards]")).toBeNull();
		expect(shownIds(container)).toEqual([]);
		// The strip is the only thing left to click to get the lane back, so it
		// has to survive the collapse.
		expect(container.querySelector("[data-lane-label]")?.textContent).toBe(
			LANE_LABELS.upcoming,
		);
		expect(container.querySelector("[data-lane-toggle]")).not.toBeNull();
	});

	it("shows the cards again when expanded", () => {
		const { container } = renderLane({ lane: "upcoming", collapsed: false });
		expect(shownIds(container)).toEqual([1, 2, 3]);
	});

	it("reports the state the listener asked for", () => {
		const onToggleCollapse = vi.fn();
		const { getByRole } = renderLane({ lane: "previous", collapsed: false, onToggleCollapse });
		fireEvent.click(getByRole("button", { name: `Collapse ${LANE_LABELS.previous}` }));
		expect(onToggleCollapse).toHaveBeenCalledWith(true);
	});

	it("offers to expand a collapsed lane", () => {
		const onToggleCollapse = vi.fn();
		const { getByRole } = renderLane({ lane: "previous", collapsed: true, onToggleCollapse });
		const toggle = getByRole("button", { name: `Expand ${LANE_LABELS.previous}` });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(onToggleCollapse).toHaveBeenCalledWith(false);
	});

	it("ignores a collapsed flag on LIVE rather than dead-ending it", () => {
		// Persisted state is untrusted, and LIVE has no control to undo a collapse
		// with — honouring a stale `true` here would hide the main lane with no way
		// back short of clearing app state.
		const { container } = renderLane({ lane: "live", collapsed: true });
		expect(shownIds(container)).toEqual([1, 2, 3]);
	});
});

describe("LaneSection ordering", () => {
	it("renders an unpinned lane chronologically", () => {
		const { container } = renderLane({ order: [] });
		expect(shownIds(container)).toEqual([1, 2, 3]);
	});

	it("renders the lane through the manual order", () => {
		// (id 3, slot 0)
		const { container } = renderLane({ order: [3, 0] });
		expect(shownIds(container)).toEqual([3, 1, 2]);
	});
});

describe("LaneSection drag, with the hand tool", () => {
	it("reorders a card within its lane", () => {
		const onReorder = vi.fn();
		const { container } = renderLane({ tool: "hand", onReorder });
		stubSlotBoxes(container);
		drag(slot(container, 3), slotCentre(0));
		expect(onReorder).toHaveBeenCalledWith(3, 0);
	});

	it("reports the index the card was dropped on, not merely 'earlier'", () => {
		const onReorder = vi.fn();
		const { container } = renderLane({ tool: "hand", onReorder });
		stubSlotBoxes(container);
		drag(slot(container, 1), slotCentre(2));
		expect(onReorder).toHaveBeenCalledWith(1, 2);
	});

	it("treats a press that barely moves as a click, not a drag", () => {
		const onReorder = vi.fn();
		const { container } = renderLane({ tool: "hand", onReorder });
		stubSlotBoxes(container);
		const source = slot(container, 3);
		const press = centreOf(source);
		const nudged = { clientX: press.clientX + 2, clientY: press.clientY + 1 };
		fireEvent.pointerDown(source, { ...press, pointerId: 1 });
		fireEvent.pointerMove(source, { ...nudged, pointerId: 1 });
		fireEvent.pointerUp(source, { ...nudged, pointerId: 1 });
		expect(onReorder).not.toHaveBeenCalled();
	});

	it("does not reorder when a card is dropped back on itself", () => {
		const onReorder = vi.fn();
		const { container } = renderLane({ tool: "hand", onReorder });
		stubSlotBoxes(container);
		// Slot 1 is where card 2 already is.
		drag(slot(container, 2), slotCentre(1));
		expect(onReorder).not.toHaveBeenCalled();
	});

	it("does not reorder when released in the lane's empty space", () => {
		const onReorder = vi.fn();
		const { container } = renderLane({ tool: "hand", onReorder });
		stubSlotBoxes(container);
		drag(slot(container, 1), { clientX: 105, clientY: 5_000 });
		expect(onReorder).not.toHaveBeenCalled();
	});

	it("abandons the drag on Escape", () => {
		const onReorder = vi.fn();
		const { container } = renderLane({ tool: "hand", onReorder });
		stubSlotBoxes(container);
		const source = slot(container, 3);
		fireEvent.pointerDown(source, { ...centreOf(source), pointerId: 1 });
		fireEvent.pointerMove(source, { ...slotCentre(0), pointerId: 1 });
		fireEvent.keyDown(source, { key: "Escape" });
		fireEvent.pointerUp(source, { ...slotCentre(0), pointerId: 1 });
		expect(onReorder).not.toHaveBeenCalled();
	});

	it("marks the card being dragged while the gesture is live", () => {
		const { container } = renderLane({ tool: "hand", onReorder: () => {} });
		stubSlotBoxes(container);
		const source = slot(container, 3);
		expect(container.querySelector("[data-dragging]")).toBeNull();
		fireEvent.pointerDown(source, { ...centreOf(source), pointerId: 1 });
		fireEvent.pointerMove(source, { ...slotCentre(0), pointerId: 1 });
		expect(container.querySelector("[data-dragging]")?.getAttribute("data-lane-item")).toBe("3");
		fireEvent.pointerUp(source, { ...slotCentre(0), pointerId: 1 });
		expect(container.querySelector("[data-dragging]")).toBeNull();
	});
});

describe("LaneSection drag across lanes", () => {
	/** LIVE at the top of the page, UPCOMING in a band 1000px below it. */
	const UPCOMING_TOP = 1_000;

	function renderTwoLanes(onLiveReorder: () => void, onUpcomingReorder: () => void) {
		const view = render(
			<>
				<LaneSection
					lane="live"
					items={ITEMS}
					tool="hand"
					onReorder={onLiveReorder}
					renderCard={renderCard}
				/>
				<LaneSection
					lane="upcoming"
					items={ITEMS}
					tool="hand"
					onReorder={onUpcomingReorder}
					renderCard={renderCard}
				/>
			</>,
		);
		const lanes = view.container.querySelectorAll("[data-lane]");
		stubSlotBoxes(lanes[0], 0);
		stubSlotBoxes(lanes[1], UPCOMING_TOP);
		return { view, live: lanes[0], upcoming: lanes[1] };
	}

	it("does not reorder either lane when a card is dropped on another lane", () => {
		// The drop-target hit test only ever scans the lane's own cards, so a
		// release over a sibling lane resolves to nothing. Lane membership is the
		// clock's to decide, not a gesture's.
		const onLive = vi.fn();
		const onUpcoming = vi.fn();
		const { live } = renderTwoLanes(onLive, onUpcoming);
		drag(slot(live, 1), slotCentre(0, UPCOMING_TOP));
		expect(onLive).not.toHaveBeenCalled();
		expect(onUpcoming).not.toHaveBeenCalled();
	});

	it("still reorders within the source lane after a cross-lane attempt", () => {
		// The failed crossing must not leave the drag machinery stuck.
		const onLive = vi.fn();
		const { live } = renderTwoLanes(onLive, vi.fn());
		drag(slot(live, 1), slotCentre(0, UPCOMING_TOP));
		drag(slot(live, 3), slotCentre(0));
		expect(onLive).toHaveBeenCalledTimes(1);
		expect(onLive).toHaveBeenCalledWith(3, 0);
	});
});

describe("LaneSection drag, with any other tool", () => {
	for (const tool of ["arrow", "mute", "unmute"] as const) {
		it(`is inert under the ${tool} tool`, () => {
			const onReorder = vi.fn();
			const { container } = renderLane({ tool, onReorder });
			stubSlotBoxes(container);
			drag(slot(container, 3), slotCentre(0));
			expect(onReorder).not.toHaveBeenCalled();
			expect(container.querySelector("[data-dragging]")).toBeNull();
			// The cards are still all there and still in order — an inert drag is a
			// no-op, not a swallowed one.
			expect(shownIds(container)).toEqual([1, 2, 3]);
		});
	}
});

describe("LaneSection labelling", () => {
	it("names each lane for a screen reader", () => {
		for (const lane of ["live", "upcoming", "previous"] as const) {
			cleanup();
			const { getByRole } = renderLane({ lane });
			expect(getByRole("region", { name: LANE_LABELS[lane] })).not.toBeNull();
		}
	});

	it("marks which lane it is, for the geometry the stylesheet applies", () => {
		const { container } = renderLane({ lane: "previous" });
		expect(container.querySelector("[data-lane]")?.getAttribute("data-lane")).toBe("previous");
	});
});
