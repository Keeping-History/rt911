// Screen-space geometry for the area-select tool (issue #225). All values are
// container-relative pixels; FlightMap projects features to pixels and tests
// membership here, so the math stays render-free and unit-testable.

export type SelectMode = "off" | "rect" | "circle";

export interface DragPixels {
	startX: number;
	startY: number;
	curX: number;
	curY: number;
}

export interface PixelBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Query bounds for a drag: the normalized box (rect mode) or the circle's
 * bounding box (circle mode — center is the drag start, radius the distance
 * to the current point).
 */
export function dragBounds(mode: Exclude<SelectMode, "off">, d: DragPixels): PixelBounds {
	if (mode === "rect") {
		return {
			minX: Math.min(d.startX, d.curX),
			minY: Math.min(d.startY, d.curY),
			maxX: Math.max(d.startX, d.curX),
			maxY: Math.max(d.startY, d.curY),
		};
	}
	const r = Math.hypot(d.curX - d.startX, d.curY - d.startY);
	return {
		minX: d.startX - r,
		minY: d.startY - r,
		maxX: d.startX + r,
		maxY: d.startY + r,
	};
}

/** Whether a projected point falls inside the dragged shape (edges count). */
export function insideSelection(
	mode: Exclude<SelectMode, "off">,
	d: DragPixels,
	x: number,
	y: number,
): boolean {
	if (mode === "rect") {
		const b = dragBounds("rect", d);
		return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
	}
	const r = Math.hypot(d.curX - d.startX, d.curY - d.startY);
	return Math.hypot(x - d.startX, y - d.startY) <= r;
}

/** Inline style for the live drag overlay div, relative to the map container. */
export function overlayStyle(
	mode: Exclude<SelectMode, "off">,
	d: DragPixels,
): { left: number; top: number; width: number; height: number; borderRadius: string } {
	const b = dragBounds(mode, d);
	return {
		left: b.minX,
		top: b.minY,
		width: b.maxX - b.minX,
		height: b.maxY - b.minY,
		borderRadius: mode === "circle" ? "50%" : "0",
	};
}
