// One of the three lanes — LIVE, UPCOMING, PREVIOUS — and the cards in it.
//
// This is the container story 014 wrote TrafficCard against: the card takes its
// lane as a prop precisely so that lane membership has exactly one author, and
// this is that author. Everything a lane needs to decide is decided here:
//
//   which cards are in it     the shell passes an already-partitioned list
//   what order they render in  applyManualOrder for the listener's drags,
//                               then stabilizeLaneOrder (story 044) for what
//                               a new arrival or the active card does to it
//   whether it is folded away  `collapsed`, except on LIVE (see below)
//   whether a drag does anything  only under the `hand` tool
//
//   whether the whole lane is silenced  `muted`, LIVE's mute-all (story 040)
//
// It holds no app state. Items, tool, order, collapse and lane mute all arrive
// as props and every change leaves by a callback, because the state that
// persists lives in the app shell (story 019) and a lane that kept its own copy
// would be a second answer free to disagree with it.
//
// What it does NOT own: the cards. `renderCard` and `renderCollapsedCard` are
// render props so the shell can wire audio, metadata and mute state per card
// without this file learning about any of it — the slot element (and therefore
// the drag) is this file's, the contents are the shell's. Which of the two runs
// is the ONE thing collapse decides here: a folded lane still renders every
// clip, in the same slots, in the same order, just in the small player instead
// of the full one (story 027).

import { ClassicyBevelButton } from "classicy";
import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { Lane } from "./cardStatus";
import { applyManualOrder, type LanePins, stabilizeLaneOrder } from "./laneOrder";
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
 * The lane mute control's artwork, in its two states.
 *
 * The same speaker TrafficCard draws on its own mute button, REDRAWN for the
 * size this one is: the lane strip is one --window-control-size wide, and a
 * bevel eats 2px of that on each side, so the glyph gets about six pixels. The
 * card's two-arc speaker and its little X both turn to mush at that size, so
 * the cone is fatter and "off" is one slash corner to corner — the mark that
 * survives being drawn six pixels wide. Same idea, legibly, rather than the
 * same path data illegibly.
 *
 * Inline rather than an <img> so it takes the strip's ink through
 * `currentColor`.
 */
const SpeakerIcon: React.FC<{ muted: boolean }> = ({ muted }) => (
	<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" role="presentation">
		<path d="M1 6h4l5-4.5v13L5 10H1z" fill="currentColor" />
		{muted ? (
			<path d="M2 14L14 2" stroke="currentColor" strokeWidth="2.5" fill="none" />
		) : (
			<path
				d="M12 4.5a5 5 0 0 1 0 7"
				stroke="currentColor"
				strokeWidth="2"
				fill="none"
			/>
		)}
	</svg>
);

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
	/**
	 * The id of the card that must not appear to move because OTHER cards
	 * arrived or left — the shell's notion of "highlighted or playing" (a
	 * soloed LIVE card, a listener-started PREVIOUS clip). Undefined or null
	 * means nothing is pinned and the lane reorders freely; see
	 * {@link stabilizeLaneOrder}, which this lane's render order is threaded
	 * through on every change.
	 */
	activeId?: number | null;
	collapsed?: boolean;
	onToggleCollapse?: (collapsed: boolean) => void;
	/**
	 * Every player in this lane is silenced, whatever its own mute says.
	 *
	 * A lane-level flag rather than a bulk edit of the per-card mutes, because
	 * the problem it solves is clips that have not ARRIVED yet: the lane refills
	 * itself as the clock runs, and a one-shot "mute what is here now" would go
	 * quiet and then start talking again a minute later.
	 */
	muted?: boolean;
	/**
	 * Flip the lane mute. Its presence is also what puts the control on the
	 * strip — the shell hands it to LIVE and to no one else, because LIVE is the
	 * only lane with a mix to silence (UPCOMING has no audio yet, and PREVIOUS
	 * plays only what the listener started by hand).
	 */
	onToggleMute?: (muted: boolean) => void;
	tool: Tool;
	/** A card was dropped on the slot at `toIndex`. */
	onReorder?: (fromId: number, toIndex: number) => void;
	renderCard: (item: MediaItem) => React.ReactNode;
	/**
	 * The same item, in the small player a folded lane shows instead (story
	 * 027). Required rather than optional: "collapsed" has exactly one meaning
	 * and a lane that could not say it would silently fall back to hiding the
	 * clips, which is the behaviour this replaced.
	 */
	renderCollapsedCard: (item: MediaItem) => React.ReactNode;
}

export const LaneSection: React.FC<LaneSectionProps> = ({
	lane,
	items,
	order = [],
	activeId = null,
	collapsed = false,
	onToggleCollapse,
	muted = false,
	onToggleMute,
	tool,
	onReorder,
	renderCard,
	renderCollapsedCard,
}) => {
	const cardsRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<DragState | null>(null);
	// Only the id being dragged is state; the rest of the gesture lives in a ref
	// because nothing renders from it and a pointermove per frame should not.
	const [draggingId, setDraggingId] = useState<number | null>(null);
	// The ids this lane rendered last tick, and the scroll width that went with
	// them — stabilizeLaneOrder's "before" and the scroll-jump compensation's
	// baseline. Undefined until the first commit: there is nothing to compare
	// the very first render against, for either.
	const previousIdsRef = useRef<readonly number[] | undefined>(undefined);
	const scrollWidthRef = useRef(0);

	const label = LANE_LABELS[lane];
	const collapsible = LANE_COLLAPSIBLE[lane];
	const isCollapsed = collapsible && collapsed;
	// applyManualOrder answers "where did the listener drag this lane's own
	// siblings"; stabilizeLaneOrder answers what a NEW sibling arriving, or an
	// old one leaving, does to that arrangement — new cards enter at the left,
	// and the active card (if it rendered last tick) holds the index it had.
	const ordered = stabilizeLaneOrder(
		applyManualOrder(items, order),
		previousIdsRef.current,
		activeId,
	);
	// Dragging is a mode, not a capability: under the other three tools a press
	// on a card means solo, mute or unmute, and reordering must not also happen.
	const canDrag = tool === "hand";

	// Runs after the DOM reflects `ordered`, before the browser paints — a
	// plain useEffect would let the jump flash on screen for one frame first.
	//
	// Compensation is scoped to ticks that actually inserted a new card: a
	// collapse toggle or a manual pin swap also changes `cardsRef`'s content
	// width, and nudging scrollLeft for either of those would introduce the
	// very jump this exists to prevent, on a gesture that never asked for one.
	useLayoutEffect(() => {
		const cards = cardsRef.current;
		const previous = previousIdsRef.current;
		if (cards) {
			const insertedAtLeft =
				previous !== undefined && ordered.some((item) => !previous.includes(item.id));
			if (insertedAtLeft) {
				const grew = cards.scrollWidth - scrollWidthRef.current;
				if (grew > 0) cards.scrollLeft += grew;
			}
			scrollWidthRef.current = cards.scrollWidth;
		}
		previousIdsRef.current = ordered.map((item) => item.id);
	}, [ordered]);

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
				{onToggleMute && (
					// A Classicy bevel button in toggle mode rather than a bare
					// <button>: it is a control that HOLDS a state, which is what
					// that mode is, and it draws the pressed-in look the rest of the
					// desktop uses for one. It carries its own aria-pressed.
					<ClassicyBevelButton
						mode="toggle"
						bevelWidth="small"
						on={muted}
						data-lane-mute
						className={styles.rtLaneMute}
						aria-label={`${muted ? "Unmute" : "Mute"} ${label}`}
						title={`${muted ? "Unmute" : "Mute"} ${label}`}
						onChangeFunc={onToggleMute}
					>
						<SpeakerIcon muted={muted} />
					</ClassicyBevelButton>
				)}
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

			{/* Rendered whether or not the lane is folded — collapse changes WHICH
			    player each slot holds, not whether the clips are on screen. */}
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
						{isCollapsed ? renderCollapsedCard(item) : renderCard(item)}
					</div>
				))}
			</div>
		</section>
	);
};
