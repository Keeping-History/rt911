import type React from "react";
import { useEffect, useRef, useState } from "react";
import { insertionIndexFromX } from "./channelOrder";

// A press only becomes a drag after this much pointer travel; below it,
// release falls through to the button's normal click (tune/select).
const DRAG_THRESHOLD_PX = 5;

export interface ThumbnailDragState {
	fromIndex: number;
	active: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
	insertionIndex: number;
	insertionX: number;
}

interface PendingDrag {
	fromIndex: number;
	pointerId: number;
	startX: number;
	startY: number;
}

/**
 * Classic Mac outline drag for the thumbnail strip: the original stays put, a
 * dashed outline follows the cursor, and an insertion bar marks the drop slot.
 * Coordinates in the returned state are strip-content coordinates (relative to
 * the strip's border box, scroll included) so overlays can be absolutely
 * positioned inside the scrolling strip.
 */
export function useThumbnailDrag({
	stripRef,
	onCommit,
}: {
	stripRef: React.RefObject<HTMLDivElement | null>;
	onCommit: (fromIndex: number, toIndex: number) => void;
}) {
	const [drag, setDrag] = useState<ThumbnailDragState | null>(null);
	const pendingRef = useRef<PendingDrag | null>(null);
	// Set when a real drag completes so the button's onClick can ignore the
	// click the browser fires after pointerup.
	const suppressNextClick = useRef(false);

	// Escape cancels an in-flight drag; the eventual pointerup is then inert.
	useEffect(() => {
		if (!drag?.active) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			pendingRef.current = null;
			suppressNextClick.current = true;
			setDrag(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [drag?.active]);

	/** The strip's thumbnail buttons' rects + pointer, in strip-content coords. */
	const measure = (e: React.PointerEvent<HTMLElement>) => {
		const strip = stripRef.current;
		if (!strip) return null;
		const stripRect = strip.getBoundingClientRect();
		const toContentX = (clientX: number) =>
			clientX - stripRect.left + strip.scrollLeft;
		const buttons = Array.from(strip.querySelectorAll<HTMLElement>("button"));
		const rects = buttons.map((b) => {
			const r = b.getBoundingClientRect();
			return { left: toContentX(r.left), width: r.width, height: r.height };
		});
		return { rects, pointerX: toContentX(e.clientX), stripRect };
	};

	const onPointerDown =
		(index: number) => (e: React.PointerEvent<HTMLElement>) => {
			if (e.button !== 0) return;
			pendingRef.current = {
				fromIndex: index,
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
			};
			suppressNextClick.current = false;
			// Keeps move/up delivered to this element even outside the strip.
			e.currentTarget.setPointerCapture?.(e.pointerId);
		};

	const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
		const pending = pendingRef.current;
		if (!pending || pending.pointerId !== e.pointerId) return;
		const moved = Math.hypot(
			e.clientX - pending.startX,
			e.clientY - pending.startY,
		);
		if (!drag && moved < DRAG_THRESHOLD_PX) return;
		const m = measure(e);
		if (!m) return;
		const from = m.rects[pending.fromIndex];
		if (!from) return;
		const insertionIndex = insertionIndexFromX(m.rects, m.pointerX);
		// Insertion bar sits at the leading edge of the slot it points into, or
		// flush after the last thumbnail.
		const last = m.rects[m.rects.length - 1];
		const insertionX =
			insertionIndex < m.rects.length
				? m.rects[insertionIndex].left
				: last.left + last.width;
		setDrag({
			fromIndex: pending.fromIndex,
			active: true,
			x: m.pointerX - from.width / 2,
			y: e.clientY - m.stripRect.top - from.height / 2,
			width: from.width,
			height: from.height,
			insertionIndex,
			insertionX,
		});
	};

	const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
		const pending = pendingRef.current;
		if (!pending || pending.pointerId !== e.pointerId) return;
		pendingRef.current = null;
		if (drag?.active) {
			suppressNextClick.current = true;
			onCommit(drag.fromIndex, drag.insertionIndex);
		}
		setDrag(null);
	};

	const onPointerCancel = () => {
		pendingRef.current = null;
		setDrag(null);
	};

	const thumbHandlers = (index: number) => ({
		onPointerDown: onPointerDown(index),
		onPointerMove,
		onPointerUp,
		onPointerCancel,
	});

	return { drag, thumbHandlers, suppressNextClick };
}
