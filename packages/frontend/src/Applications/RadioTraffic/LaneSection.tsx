// One of the three lanes — LIVE, UPCOMING, PREVIOUS — and the cards in it.
//
// This is the container story 014 wrote TrafficCard against: the card takes its
// lane as a prop precisely so that lane membership has exactly one author, and
// this is that author. Everything a lane needs to decide is decided here:
//
//   which cards are in it     the shell passes an already-partitioned list
//   what order they render in  applyManualOrder, from this lane's pins
//   whether it is folded away  `collapsed`, except on LIVE (see below)
//   whether a drag does anything  only under the `hand` tool
//
// It holds no app state. Items, tool, order and collapse all arrive as props
// and every change leaves by a callback, because the state that persists lives
// in the app shell (story 019) and a lane that kept its own copy would be a
// second answer free to disagree with it.
//
// What it does NOT own: the cards. `renderCard` is a render prop so the shell
// can wire audio, metadata and mute state per card without this file learning
// about any of it — the slot element (and therefore the drag) is this file's,
// the contents are the shell's.

import type React from "react";
import { useRef, useState } from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { Lane } from "./cardStatus";
import { applyManualOrder, type LanePins } from "./laneOrder";
import styles from "./laneSection.module.scss";
import type { Tool } from "./toolMode";

export const LANE_LABELS: Record<Lane, string> = {
	live: "LIVE",
	upcoming: "UPCOMING",
	previous: "PREVIOUS",
};

/**
 * LIVE has no expand/collapse control in the design, and this is why it also
 * ignores the flag: it is the lane the app exists to show, and with no control
 * on the strip there would be nothing to click to bring it back. A stale
 * persisted `true` would otherwise hide it for good.
 */
export const LANE_COLLAPSIBLE: Record<Lane, boolean> = {
	live: false,
	upcoming: true,
	previous: true,
};

/**
 * Movement, in px, that separates a click from a drag. Below it the gesture is
 * still a tool click on the card; above it the lane is being reordered. Same
 * constant and same reasoning as the TV thumbnail strip's reorder — a press
 * is genuinely ambiguous until the pointer moves.
 */
const DRAG_THRESHOLD_PX = 5;

interface DragState {
	fromId: number;
	startX: number;
	startY: number;
	dragging: boolean;
}

/**
 * The index of the card slot under the pointer, or null for none.
 *
 * `cards` is THIS lane's card container and nothing else, which is the whole
 * mechanism behind "a card cannot be dragged across lanes": released over a
 * sibling lane, the pointer is over none of these boxes and the gesture
 * resolves to nothing. Which lane a card belongs to is the clock's answer, and
 * a drag is not entitled to a different one.
 */
function dropIndexAt(cards: HTMLElement | null, clientX: number, clientY: number): number | null {
	if (!cards) return null;
	const slots = Array.from(cards.children).filter(
		(child): child is HTMLElement => (child as HTMLElement).dataset?.laneItem !== undefined,
	);
	for (let i = 0; i < slots.length; i++) {
		const { left, right, top, bottom } = slots[i].getBoundingClientRect();
		if (clientX >= left && clientX <= right && clientY >= top && clientY <= bottom) return i;
	}
	return null;
}

export interface LaneSectionProps {
	lane: Lane;
	/** The items the clock puts in this lane, chronological. */
	items: readonly MediaItem[];
	/** This lane's pins — see laneOrder. Absent means nothing was ever dragged. */
	order?: LanePins;
	collapsed?: boolean;
	onToggleCollapse?: (collapsed: boolean) => void;
	tool: Tool;
	/** A card was dropped on the slot at `toIndex`. */
	onReorder?: (fromId: number, toIndex: number) => void;
	renderCard: (item: MediaItem) => React.ReactNode;
}

export const LaneSection: React.FC<LaneSectionProps> = ({
	lane,
	items,
	order = [],
	collapsed = false,
	onToggleCollapse,
	tool,
	onReorder,
	renderCard,
}) => {
	const cardsRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<DragState | null>(null);
	// Only the id being dragged is state; the rest of the gesture lives in a ref
	// because nothing renders from it and a pointermove per frame should not.
	const [draggingId, setDraggingId] = useState<number | null>(null);

	const label = LANE_LABELS[lane];
	const collapsible = LANE_COLLAPSIBLE[lane];
	const isCollapsed = collapsible && collapsed;
	const ordered = applyManualOrder(items, order);
	// Dragging is a mode, not a capability: under the other three tools a press
	// on a card means solo, mute or unmute, and reordering must not also happen.
	const canDrag = tool === "hand";

	const endDrag = (target: HTMLElement, pointerId: number) => {
		dragRef.current = null;
		setDraggingId(null);
		target.releasePointerCapture?.(pointerId);
	};

	const dragHandlers = (fromId: number) => ({
		onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
			dragRef.current = { fromId, startX: e.clientX, startY: e.clientY, dragging: false };
			// Keep receiving moves once the pointer leaves the card — including when
			// it leaves over another lane, which is a case that must resolve to a
			// no-op rather than to whatever is under the cursor.
			e.currentTarget.setPointerCapture?.(e.pointerId);
		},
		onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
			const drag = dragRef.current;
			if (!drag || drag.dragging) return;
			if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= DRAG_THRESHOLD_PX) {
				return;
			}
			drag.dragging = true;
			setDraggingId(drag.fromId);
		},
		onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
			const drag = dragRef.current;
			endDrag(e.currentTarget, e.pointerId);
			if (!drag?.dragging) return;
			const toIndex = dropIndexAt(cardsRef.current, e.clientX, e.clientY);
			// No slot under the pointer (another lane, or the gap between cards),
			// or the card's own slot: either way the listener asked for nothing.
			if (toIndex === null || ordered[toIndex]?.id === drag.fromId) return;
			onReorder?.(drag.fromId, toIndex);
		},
		onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => {
			endDrag(e.currentTarget, e.pointerId);
		},
		onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key === "Escape" && dragRef.current) {
				dragRef.current = null;
				setDraggingId(null);
			}
		},
	});

	return (
		<section
			className={styles.rtLane}
			aria-label={label}
			data-lane={lane}
			data-collapsed={isCollapsed}
			// The stylesheet hangs the grab cursor off this, so the affordance and
			// the handlers cannot disagree about whether dragging is live.
			data-tool={tool}
		>
			<div className={styles.rtLaneStrip}>
				<span className={styles.rtLaneLabel} data-lane-label>
					{label}
				</span>
				{collapsible && (
					<button
						type="button"
						className={styles.rtLaneToggle}
						data-lane-toggle
						aria-expanded={!isCollapsed}
						aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
						title={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
						onClick={() => onToggleCollapse?.(!isCollapsed)}
					>
						<span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
					</button>
				)}
			</div>

			{!isCollapsed && (
				<div className={styles.rtLaneCards} data-lane-cards ref={cardsRef}>
					{ordered.map((item) => (
						// A plain div rather than a control: the slot is a drag surface
						// for a pointer tool, and the card inside it carries the app's
						// actual controls with their own keyboard paths. Making the slot
						// focusable would put a tab stop in front of every one of them.
						<div
							key={item.id}
							className={styles.rtLaneSlot}
							data-lane-item={item.id}
							data-dragging={draggingId === item.id || undefined}
							{...(canDrag ? dragHandlers(item.id) : {})}
						>
							{renderCard(item)}
						</div>
					))}
				</div>
			)}
		</section>
	);
};
