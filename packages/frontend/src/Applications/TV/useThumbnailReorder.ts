import type React from "react";
import { useCallback, useRef, useState } from "react";

/**
 * Pointer-drag reordering for the TV thumbnail strip.
 *
 * A press is ambiguous until the pointer moves: under the threshold it stays a
 * click (focus a channel, or toggle it in multiview); past the threshold it
 * becomes a reorder drag and the click is suppressed. That threshold IS the
 * "dragging must not focus a video" requirement — not an add-on to it.
 *
 * Hand-rolled rather than dnd-kit: the activation constraint we'd configure
 * there is the same few lines, and this keeps mouse and touch on one path for
 * the shared mobile shell.
 */
export const DRAG_THRESHOLD_PX = 5;

interface DragState {
	source: string;
	startX: number;
	startY: number;
	dragging: boolean;
	cancelled: boolean;
}

/** Which tile's box contains `clientX`, read off the strip's DOM children. */
function sourceAtX(target: EventTarget & HTMLButtonElement, clientX: number): string | null {
	const strip = target.parentElement;
	if (!strip) return null;
	for (const child of Array.from(strip.children) as HTMLElement[]) {
		const source = child.dataset?.source;
		if (!source) continue;
		const { left, right } = child.getBoundingClientRect();
		if (clientX >= left && clientX <= right) return source;
	}
	return null;
}

export function useThumbnailReorder(onReorder: (from: string, to: string) => void) {
	const dragRef = useRef<DragState | null>(null);
	// Set on a completed drag, read-and-cleared by the tile's onClick guard.
	const suppressClickRef = useRef(false);
	const [dragSource, setDragSource] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);

	const reset = useCallback(() => {
		dragRef.current = null;
		setDragSource(null);
		setDropTarget(null);
	}, []);

	/**
	 * Whether a drag just ended. Clears the flag as it reads, so suppression
	 * cannot leak into the next genuine click.
	 */
	const consumeSuppressedClick = useCallback(() => {
		const suppressed = suppressClickRef.current;
		suppressClickRef.current = false;
		return suppressed;
	}, []);

	const handlers = useCallback(
		(source: string) => ({
			onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
				dragRef.current = {
					source,
					startX: e.clientX,
					startY: e.clientY,
					dragging: false,
					cancelled: false,
				};
				// Keep receiving moves even if the pointer leaves this tile.
				e.currentTarget.setPointerCapture?.(e.pointerId);
			},
			onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
				const drag = dragRef.current;
				if (!drag || drag.cancelled) return;
				if (!drag.dragging) {
					const dx = e.clientX - drag.startX;
					const dy = e.clientY - drag.startY;
					if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
					drag.dragging = true;
					setDragSource(drag.source);
				}
				setDropTarget(sourceAtX(e.currentTarget, e.clientX));
			},
			onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
				const drag = dragRef.current;
				if (!drag) return;
				if (drag.dragging && !drag.cancelled) {
					const target = sourceAtX(e.currentTarget, e.clientX);
					if (target && target !== drag.source) onReorder(drag.source, target);
					// Suppress even a no-op drop: the gesture was a drag, not a click.
					suppressClickRef.current = true;
				}
				e.currentTarget.releasePointerCapture?.(e.pointerId);
				reset();
			},
			onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => {
				e.currentTarget.releasePointerCapture?.(e.pointerId);
				reset();
			},
			onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
				if (e.key === "Escape" && dragRef.current?.dragging) {
					dragRef.current.cancelled = true;
					setDragSource(null);
					setDropTarget(null);
				}
			},
		}),
		[onReorder, reset],
	);

	return { dragSource, dropTarget, consumeSuppressedClick, handlers };
}
