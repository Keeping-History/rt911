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
//   whether it is folded away  `collapsed`, except LIVE (forced open) and
//                               UPCOMING (forced closed) — see below
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
import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
 * Lanes with no expand/collapse control on the strip, and the fold state each
 * is fixed at instead of reading `collapsed`.
 *
 * LIVE is forced OPEN: it is the lane the app exists to show, and with no
 * control on the strip there would be nothing to click to bring it back. A
 * stale persisted `true` would otherwise hide it for good.
 *
 * UPCOMING is forced CLOSED — always the small player, never the full card —
 * per the design. Same reasoning in the other direction: with no button on
 * the strip, a stale persisted `false` would otherwise leave it stuck open.
 *
 * PREVIOUS is absent from this map: its fold state is exactly whatever
 * `collapsed` says, and its strip is the only one that carries the button.
 */
export const LANE_FIXED_COLLAPSE: Partial<Record<Lane, boolean>> = {
	live: false,
	upcoming: true,
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
 * The cursor-following drag visual: a box the size of the dragged card,
 * centered on the pointer, in the lane's `.rtLaneCards` strip's content
 * coordinates (relative to the strip's border box with its horizontal scroll
 * added back, so it can be absolutely positioned inside the scrolling strip).
 *
 * Same shape, and the same TV thumbnail-strip technique it is named after —
 * see `TV/useThumbnailReorder.ts`'s `DragOutline` — but computed inline here
 * rather than shared: this lane's strip can be a flex row OR (LIVE) a 2-row
 * CSS grid, and this is plain rect math against the container either way, not
 * flex/grid-aware, so nothing about that difference actually needs sharing.
 */
interface DragOutline {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The lane mute control's artwork, in its three states (issue #537 item 5).
 *
 * The same speaker TrafficCard draws on its own mute button, REDRAWN for the
 * size this one is: the lane strip is one --window-control-size wide, and a
 * bevel eats 2px of that on each side, so the glyph gets about six pixels. The
 * card's two-arc speaker and its little X both turn to mush at that size, so
 * the cone is fatter and "off" is one slash corner to corner — the mark that
 * survives being drawn six pixels wide. Same idea, legibly, rather than the
 * same path data illegibly.
 *
 * `partial` is the new middle state: at least one station is muted by hand,
 * short of the mute-ALL press this button itself makes. It draws the same
 * cone with no sound wave at all — neither the crossed-out "everything is
 * silent" mark nor the arc that means "everything is getting through" — so a
 * listener can tell "some of the mix is silenced" apart from both ends
 * without the button itself reporting the pressed, mute-everything state
 * `muted` means. `muted` (mute-all) still wins when both are true: pressing
 * mute-all while some cards are already muted by hand is still the button
 * saying "everything", not "some things".
 *
 * Inline rather than an <img> so it takes the strip's ink through
 * `currentColor`.
 */
const SpeakerIcon: React.FC<{ muted: boolean; partial?: boolean }> = ({
	muted,
	partial = false,
}) => (
	<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" role="presentation">
		<path d="M1 6h4l5-4.5v13L5 10H1z" fill="currentColor" />
		{muted ? (
			<path d="M2 14L14 2" stroke="currentColor" strokeWidth="2.5" fill="none" />
		) : partial ? null : (
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
	 * Issue #537 item 5: at least one player in this lane is muted individually
	 * — the middle of the mute button's three icon states — WITHOUT the whole
	 * lane being silenced by `muted`. Purely cosmetic: it changes the glyph
	 * `SpeakerIcon` draws and nothing about `on`/aria-pressed, which stay
	 * `muted`'s alone — the button is only ever actually PRESSED for mute-all.
	 */
	partiallyMuted?: boolean;
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
	partiallyMuted = false,
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
	// The cursor-following outline's box, live for the duration of a drag —
	// unlike draggingId this DOES change every pointermove, because it is what
	// the outline element's inline style reads.
	const [dragOutline, setDragOutline] = useState<DragOutline | null>(null);
	// The ids this lane rendered last tick — stabilizeLaneOrder's "before".
	// Undefined until the first commit: there is nothing to compare the very
	// first render against.
	const previousIdsRef = useRef<readonly number[] | undefined>(undefined);
	// Every surviving card's own x-position, snapshotted after each commit —
	// the scroll-jump compensation's baseline. A per-card position rather than
	// a single scrollWidth number so a card leaving (not just one arriving) can
	// be compensated for, and so an arrival or departure OUTSIDE the visible
	// window (to the right of what the listener can see) costs nothing: only a
	// card whose own position moved says the scroll needs to.
	const scrollSnapshotRef = useRef<{ offsets: Map<number, number>; scrollLeft: number } | null>(
		null,
	);

	const label = LANE_LABELS[lane];
	const fixedCollapse = LANE_FIXED_COLLAPSE[lane];
	const collapsible = fixedCollapse === undefined;
	const isCollapsed = collapsible ? collapsed : fixedCollapse;
	// applyManualOrder answers "where did the listener drag this lane's own
	// siblings"; stabilizeLaneOrder answers what a NEW sibling arriving, or an
	// old one leaving, does to that arrangement — new cards enter at the left,
	// and the active card (if it rendered last tick) holds the index it had.
	//
	// Memoized, not recomputed inline: this component re-renders on every
	// clock tick AND on every unrelated MediaStream frame the shell receives
	// (mp3, pager, flights, weather, …), because RadioTraffic reads the whole
	// shared context. Without this, `ordered` was a fresh array on every one
	// of those renders, which made the useLayoutEffect below — a forced
	// synchronous DOM reflow over every card in the lane — re-run on every
	// render too, not just ticks that actually changed which cards are here.
	// With enough live traffic cards accumulated, that was enough to pin the
	// main thread; `items` and `order` are themselves stable across an
	// unrelated render (memoized upstream / plain state), so this actually
	// has something to skip.
	const ordered = useMemo(
		() => stabilizeLaneOrder(applyManualOrder(items, order), previousIdsRef.current, activeId),
		[items, order, activeId],
	);
	// Dragging is a mode, not a capability: under the other three tools a press
	// on a card means solo, mute or unmute, and reordering must not also happen.
	const canDrag = tool === "hand";

	// Runs after the DOM reflects `ordered`, before the browser paints — a
	// plain useEffect would let the jump flash on screen for one frame first.
	//
	// Compensation is scoped to ticks that actually added or removed a card: a
	// collapse toggle or a manual pin swap also re-lays-out `cardsRef`'s
	// content, and nudging scrollLeft for either of those would introduce the
	// very jump this exists to prevent, on a gesture that never asked for one
	// (a manual drag is the one case a card SHOULD visibly move).
	useLayoutEffect(() => {
		const cards = cardsRef.current;
		const previous = previousIdsRef.current;
		if (cards) {
			const currentIds = ordered.map((item) => item.id);
			const idSetChanged =
				previous !== undefined &&
				(currentIds.length !== previous.length ||
					currentIds.some((id) => !previous.includes(id)) ||
					previous.some((id) => !currentIds.includes(id)));

			const newOffsets = new Map<number, number>();
			for (const child of Array.from(cards.children)) {
				const raw = (child as HTMLElement).dataset.laneItem;
				if (raw !== undefined) newOffsets.set(Number(raw), (child as HTMLElement).offsetLeft);
			}

			const snapshot = scrollSnapshotRef.current;
			if (idSetChanged && snapshot && previous) {
				// The anchor is the first card, IN THE OLD ORDER, that was at or
				// past the old scroll position — the leftmost card the listener
				// could actually see before this update. Walking `previous` rather
				// than the new `currentIds` matters: it is what makes this the
				// card that WAS at the viewport's edge, not just whichever
				// survivor happens to be first now — a card arriving or leaving
				// anywhere ELSE in the lane must not be free to relabel a
				// different card as "where the listener was looking."
				for (const id of previous) {
					const before = snapshot.offsets.get(id);
					if (before === undefined || before < snapshot.scrollLeft) continue;
					// Found the true anchor. If it did not survive this update —
					// it was the card that left — there is no "where it ended up"
					// to chase, so scrollLeft is left exactly where it was rather
					// than substituting a different card's movement for its own.
					const after = newOffsets.get(id);
					if (after !== undefined) {
						const delta = after - before;
						if (delta !== 0) cards.scrollLeft += delta;
					}
					break;
				}
			}

			// This tick's layout is the next tick's baseline, whether or not it
			// was compensated — `cards.scrollLeft` is read back rather than
			// computed, so a real browser clamping the assignment above is
			// exactly what the next comparison measures against too.
			scrollSnapshotRef.current = { offsets: newOffsets, scrollLeft: cards.scrollLeft };
		}
		previousIdsRef.current = ordered.map((item) => item.id);
	}, [ordered]);

	const endDrag = (target: HTMLElement, pointerId: number) => {
		dragRef.current = null;
		setDraggingId(null);
		setDragOutline(null);
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
			if (!drag) return;
			if (!drag.dragging) {
				if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= DRAG_THRESHOLD_PX) {
					return;
				}
				drag.dragging = true;
				setDraggingId(drag.fromId);
			}
			// Pointer capture keeps events on the pressed card, so currentTarget is
			// always the dragged card's own slot — same as TV's useThumbnailReorder.
			const cards = cardsRef.current;
			if (cards) {
				const stripRect = cards.getBoundingClientRect();
				const cardRect = e.currentTarget.getBoundingClientRect();
				const width = cardRect.right - cardRect.left;
				const height = cardRect.bottom - cardRect.top;
				setDragOutline({
					x: e.clientX - stripRect.left + cards.scrollLeft - width / 2,
					y: e.clientY - stripRect.top - height / 2,
					width,
					height,
				});
			}
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
				setDragOutline(null);
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
						// Cosmetic only, never read for the pressed state itself — see
						// SpeakerIcon's doc comment. A screen reader is told the same
						// "some stations are muted" fact the icon draws, on top of
						// whichever of Mute/Unmute the press itself still does.
						data-partially-muted={!muted && partiallyMuted}
						className={styles.rtLaneMute}
						aria-label={`${muted ? "Unmute" : "Mute"} ${label}${
							!muted && partiallyMuted ? " (some stations muted)" : ""
						}`}
						title={`${muted ? "Unmute" : "Mute"} ${label}${
							!muted && partiallyMuted ? " (some stations muted)" : ""
						}`}
						onChangeFunc={onToggleMute}
					>
						<SpeakerIcon muted={muted} partial={!muted && partiallyMuted} />
					</ClassicyBevelButton>
				)}
				{collapsible && (
					// A Classicy bevel button rather than a bare <button>, like the mute
					// control above — plain `push` mode (its default) because this is a
					// disclosure trigger, not a control that holds a state: aria-expanded
					// already says which way it currently opens, and adding
					// ClassicyBevelButton's own aria-pressed on top (mode="toggle") would
					// be a second, redundant state for the same fact.
					<ClassicyBevelButton
						square
						bevelWidth="small"
						data-lane-toggle
						aria-expanded={!isCollapsed}
						aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
						title={`${isCollapsed ? "Expand" : "Collapse"} ${label}`}
						onClickFunc={() => onToggleCollapse?.(!isCollapsed)}
					>
						<span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
					</ClassicyBevelButton>
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
				{dragOutline && (
					// The cursor-following "marching ants" box — TV's tvDragOutline
					// technique, RadioTraffic-prefixed. Rendered last so it paints above
					// every card slot; the dragged card's own slot keeps the dim
					// (data-dragging → opacity 0.5) rather than hiding it, exactly the
					// tvPlayerDragging/tvDragOutline split TV.tsx uses.
					<div
						className={styles.rtDragOutline}
						data-drag-outline
						style={{
							left: dragOutline.x,
							top: dragOutline.y,
							width: dragOutline.width,
							height: dragOutline.height,
						}}
					/>
				)}
			</div>
		</section>
	);
};
