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

/** The small-player stub — the shell's other renderer, for a folded lane. */
const renderCollapsedCard = (item: MediaItem) => (
	<div data-small-card={item.id}>{item.full_title}</div>
);

function renderLane(
	props: {
		lane?: Lane;
		items?: MediaItem[];
		order?: readonly number[];
		collapsed?: boolean;
		onToggleCollapse?: (collapsed: boolean) => void;
		muted?: boolean;
		onToggleMute?: (muted: boolean) => void;
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
			muted={props.muted}
			onToggleMute={props.onToggleMute}
			tool={props.tool ?? "hand"}
			onReorder={props.onReorder}
			renderCard={renderCard}
			renderCollapsedCard={renderCollapsedCard}
		/>,
	);
}

/** The ids of the cards rendered in their FULL form. */
function fullIds(root: ParentNode): number[] {
	return Array.from(root.querySelectorAll("[data-card]")).map((el) =>
		Number(el.getAttribute("data-card")),
	);
}

/** The ids of the cards rendered as small players. */
function smallIds(root: ParentNode): number[] {
	return Array.from(root.querySelectorAll("[data-small-card]")).map((el) =>
		Number(el.getAttribute("data-small-card")),
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
		// The design has expand/collapse on PREVIOUS only. LIVE is what the app is
		// for; it does not fold away.
		const { container } = renderLane({ lane: "live" });
		expect(container.querySelector("[data-lane-toggle]")).toBeNull();
	});

	it("gives UPCOMING no collapse control either", () => {
		// UPCOMING is permanently minimized (see below) — with no way back to the
		// full card, a button offering to expand it would do nothing.
		const { container } = renderLane({ lane: "upcoming" });
		expect(container.querySelector("[data-lane-toggle]")).toBeNull();
	});

	it("gives PREVIOUS a collapse control", () => {
		const { container } = renderLane({ lane: "previous" });
		expect(container.querySelector("[data-lane-toggle]")).not.toBeNull();
	});

	it("switches to the small player when collapsed, rather than hiding the clips", () => {
		// Story 027: collapsing used to empty the lane, which threw away the one
		// thing a listener collapses a lane to keep. Every clip is still here, in
		// the same slots, in the compact form instead.
		const { container } = renderLane({ lane: "previous", collapsed: true });
		expect(shownIds(container)).toEqual([1, 2, 3]);
		expect(smallIds(container)).toEqual([1, 2, 3]);
		expect(fullIds(container)).toEqual([]);
	});

	it("keeps the label and the control while collapsed", () => {
		const { container } = renderLane({ lane: "previous", collapsed: true });
		// The strip is the only thing left to click to get the lane back, so it
		// has to survive the collapse.
		expect(container.querySelector("[data-lane-label]")?.textContent).toBe(
			LANE_LABELS.previous,
		);
		expect(container.querySelector("[data-lane-toggle]")).not.toBeNull();
	});

	it("shows the full players again when expanded", () => {
		const { container } = renderLane({ lane: "previous", collapsed: false });
		expect(shownIds(container)).toEqual([1, 2, 3]);
		expect(fullIds(container)).toEqual([1, 2, 3]);
		expect(smallIds(container)).toEqual([]);
	});

	it("keeps the manual order across the fold", () => {
		// The slots are the same slots — collapse decides what goes IN them and
		// nothing else, so a lane the listener has rearranged stays rearranged.
		const { container } = renderLane({ lane: "previous", collapsed: true, order: [3, 0] });
		expect(smallIds(container)).toEqual([3, 1, 2]);
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
		// with — honouring a stale `true` here would shrink the main lane to small
		// players with no way back short of clearing app state.
		const { container } = renderLane({ lane: "live", collapsed: true });
		expect(shownIds(container)).toEqual([1, 2, 3]);
		expect(fullIds(container)).toEqual([1, 2, 3]);
		expect(smallIds(container)).toEqual([]);
	});

	it("stays minimized on UPCOMING even when a stale collapsed flag says false", () => {
		// Same reasoning as LIVE above, mirrored: UPCOMING has no control to undo
		// a fold with, so a persisted `false` must not be honoured either — the
		// lane always renders as the small player.
		const { container } = renderLane({ lane: "upcoming", collapsed: false });
		expect(shownIds(container)).toEqual([1, 2, 3]);
		expect(smallIds(container)).toEqual([1, 2, 3]);
		expect(fullIds(container)).toEqual([]);
	});
});

describe("LaneSection lane mute", () => {
	// Story 040. The control is offered by the SHELL, per lane, by handing this
	// component a callback — LIVE is the only lane with a mix to silence, and a
	// lane the shell said nothing about must not grow a button that edits state
	// nobody is holding.

	it("shows no mute control on a lane the shell gave no mute callback", () => {
		const { container } = renderLane({ lane: "upcoming" });
		expect(container.querySelector("[data-lane-mute]")).toBeNull();
	});

	it("puts the mute control on the strip, beside the collapse control", () => {
		const { container } = renderLane({ lane: "previous", onToggleMute: vi.fn() });
		const strip = container.querySelector("[data-lane-label]")?.parentElement;
		expect(strip?.querySelector("[data-lane-mute]")).not.toBeNull();
		expect(strip?.querySelector("[data-lane-toggle]")).not.toBeNull();
	});

	it("asks the shell to mute a lane that is not muted", () => {
		const onToggleMute = vi.fn();
		const { getByRole } = renderLane({ lane: "live", muted: false, onToggleMute });
		fireEvent.click(getByRole("button", { name: `Mute ${LANE_LABELS.live}` }));
		expect(onToggleMute).toHaveBeenCalledWith(true);
	});

	it("asks the shell to unmute a lane that is muted", () => {
		const onToggleMute = vi.fn();
		const { getByRole } = renderLane({ lane: "live", muted: true, onToggleMute });
		fireEvent.click(getByRole("button", { name: `Unmute ${LANE_LABELS.live}` }));
		expect(onToggleMute).toHaveBeenCalledWith(false);
	});

	it("reflects the lane's state rather than its own idea of it", () => {
		// The control is the shell's state drawn, not a second copy of it: a
		// button that tracked its own presses would drift the moment the shell
		// cleared the lane mute for it — which is exactly what a card click does.
		const { container } = renderLane({ lane: "live", muted: true, onToggleMute: vi.fn() });
		expect(container.querySelector("[data-lane-mute]")?.getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("reports an unmuted lane as unpressed", () => {
		const { container } = renderLane({ lane: "live", muted: false, onToggleMute: vi.fn() });
		expect(container.querySelector("[data-lane-mute]")?.getAttribute("aria-pressed")).toBe(
			"false",
		);
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

describe("LaneSection automatic ordering (story 044)", () => {
	// Story 044: a new item entering a lane must not be free to shove the card
	// the listener is actually looking at around, and its arrival must not
	// leave the lane scrolled to a spot that no longer shows what it did a
	// moment ago. Both are stabilizeLaneOrder's job (laneOrder.test.ts covers
	// it exhaustively); these confirm LaneSection actually wires it in.

	it("renders a new arrival at the left of the lane", () => {
		const { container, rerender } = render(
			<LaneSection
				lane="live"
				items={ITEMS}
				tool="hand"
				renderCard={renderCard}
				renderCollapsedCard={renderCollapsedCard}
			/>,
		);
		expect(shownIds(container)).toEqual([1, 2, 3]);

		const FOUR = makeItem({ id: 4, full_title: "clip 4" });
		rerender(
			<LaneSection
				lane="live"
				items={[...ITEMS, FOUR]}
				tool="hand"
				renderCard={renderCard}
				renderCollapsedCard={renderCollapsedCard}
			/>,
		);
		expect(shownIds(container)).toEqual([4, 1, 2, 3]);
	});

	it("locks the active card's index across a new arrival, letting the rest reflow", () => {
		const { container, rerender } = render(
			<LaneSection
				lane="live"
				items={ITEMS}
				activeId={2}
				tool="hand"
				renderCard={renderCard}
				renderCollapsedCard={renderCollapsedCard}
			/>,
		);
		expect(shownIds(container)).toEqual([1, 2, 3]);

		const FOUR = makeItem({ id: 4, full_title: "clip 4" });
		rerender(
			<LaneSection
				lane="live"
				items={[...ITEMS, FOUR]}
				activeId={2}
				tool="hand"
				renderCard={renderCard}
				renderCollapsedCard={renderCollapsedCard}
			/>,
		);
		// Card 2 held index 1 before the arrival; it holds index 1 after, too —
		// the new card and the other two reflow around it instead of it moving.
		expect(shownIds(container)).toEqual([4, 2, 1, 3]);
	});

	it("compensates the lane's scroll offset when a new card is inserted at the left", () => {
		const { container, rerender } = render(
			<LaneSection
				lane="live"
				items={ITEMS}
				tool="hand"
				renderCard={renderCard}
				renderCollapsedCard={renderCollapsedCard}
			/>,
		);
		const cards = container.querySelector("[data-lane-cards]") as HTMLElement;
		// jsdom performs no layout, so scrollWidth/scrollLeft are inert without
		// this — the same stubbing trick stubSlotBoxes uses for
		// getBoundingClientRect, just for the two properties the compensation
		// effect reads instead.
		Object.defineProperty(cards, "scrollWidth", { value: 300, configurable: true });
		Object.defineProperty(cards, "scrollLeft", {
			value: 50,
			writable: true,
			configurable: true,
		});

		const FOUR = makeItem({ id: 4, full_title: "clip 4" });
		rerender(
			<LaneSection
				lane="live"
				items={[...ITEMS, FOUR]}
				tool="hand"
				renderCard={renderCard}
				renderCollapsedCard={renderCollapsedCard}
			/>,
		);
		// The card row grew by the new card's width; the scroll position moves by
		// the same amount so the cards already on screen stay on screen.
		expect(cards.scrollLeft).toBe(350);
	});

	it("leaves scrollLeft alone on a render that inserted nothing new", () => {
		const { container, rerender } = render(
			<LaneSection
				lane="live"
				items={ITEMS}
				tool="hand"
				renderCard={renderCard}
				renderCollapsedCard={renderCollapsedCard}
			/>,
		);
		const cards = container.querySelector("[data-lane-cards]") as HTMLElement;
		Object.defineProperty(cards, "scrollWidth", { value: 300, configurable: true });
		Object.defineProperty(cards, "scrollLeft", {
			value: 50,
			writable: true,
			configurable: true,
		});

		// Same items; only the lane's own mute state changed. Nothing arrived,
		// so nudging scrollLeft here would be a jump with no cause.
		rerender(
			<LaneSection
				lane="live"
				items={ITEMS}
				muted
				onToggleMute={() => {}}
				tool="hand"
				renderCard={renderCard}
				renderCollapsedCard={renderCollapsedCard}
			/>,
		);
		expect(cards.scrollLeft).toBe(50);
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
					renderCollapsedCard={renderCollapsedCard}
				/>
				<LaneSection
					lane="upcoming"
					items={ITEMS}
					tool="hand"
					onReorder={onUpcomingReorder}
					renderCard={renderCard}
					renderCollapsedCard={renderCollapsedCard}
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

describe("LaneSection chrome hooks", () => {
	// The lane's whole appearance — stripe, fill, border and its share of the
	// window's height — is selected off these two attributes. They are the
	// contract between this component and laneSection.module.scss, so a refactor
	// that renamed or dropped one would silently un-style the app rather than
	// fail a test somewhere. These pin them.

	it("gives every lane its own data-lane, so each can be styled apart", () => {
		// LIVE is striped, UPCOMING and PREVIOUS are flat greys, and all three
		// take different shares of the column. One shared value would collapse
		// all of that into one appearance.
		for (const lane of ["live", "upcoming", "previous"] as const) {
			cleanup();
			const { container } = renderLane({ lane });
			expect(container.querySelector("[data-lane]")?.getAttribute("data-lane")).toBe(lane);
		}
	});

	it("reports a collapsed lane in the attribute the height rule reads", () => {
		// A collapsed lane stops claiming its share of the column and shrinks to
		// its strip. That rule keys off data-collapsed, so the flag has to reach
		// the DOM and not merely hide the cards.
		const { container } = renderLane({ lane: "previous", collapsed: true });
		expect(container.querySelector("[data-lane]")?.getAttribute("data-collapsed")).toBe("true");
	});

	it("reports an expanded lane as not collapsed", () => {
		const { container } = renderLane({ lane: "previous", collapsed: false });
		expect(container.querySelector("[data-lane]")?.getAttribute("data-collapsed")).toBe("false");
	});

	it("never reports LIVE as collapsed, whatever it is told", () => {
		// Same reasoning as the collapse suite's stale-flag test, but for the
		// height rule: honouring a persisted `true` here would hand LIVE's 3/6 of
		// the window away with no control on screen to claim it back.
		const { container } = renderLane({ lane: "live", collapsed: true });
		expect(container.querySelector("[data-lane]")?.getAttribute("data-collapsed")).toBe("false");
	});

	it("always reports UPCOMING as collapsed, whatever it is told", () => {
		// Mirror of the LIVE case above: UPCOMING has no control on screen to
		// claim its row back either, so a persisted `false` must not be honoured.
		const { container } = renderLane({ lane: "upcoming", collapsed: false });
		expect(container.querySelector("[data-lane]")?.getAttribute("data-collapsed")).toBe("true");
	});

	it("keeps the cards in their own box, separate from the label strip", () => {
		// The lane's height is fixed by the design, so the overflow has to scroll
		// somewhere that is NOT the strip — otherwise a full lane scrolls its own
		// label out of view.
		const { container } = renderLane({ lane: "previous" });
		const cards = container.querySelector("[data-lane-cards]");
		expect(cards).not.toBeNull();
		expect(cards?.querySelector("[data-lane-label]")).toBeNull();
		expect(shownIds(cards as ParentNode)).toEqual([1, 2, 3]);
	});
});
