import { describe, expect, it } from "vitest";
import { dragBounds, insideSelection, overlayStyle, type DragPixels } from "./selectTool";

const drag = (startX: number, startY: number, curX: number, curY: number): DragPixels => ({
	startX, startY, curX, curY,
});

describe("dragBounds", () => {
	it("normalizes a reversed rectangle drag", () => {
		expect(dragBounds("rect", drag(100, 100, 20, 40))).toEqual({
			minX: 20, minY: 40, maxX: 100, maxY: 100,
		});
	});

	it("circle bounds are the radius box around the drag start", () => {
		// start (0,0), current (30,40) → r = 50.
		expect(dragBounds("circle", drag(0, 0, 30, 40))).toEqual({
			minX: -50, minY: -50, maxX: 50, maxY: 50,
		});
	});
});

describe("insideSelection", () => {
	it("rect: contains interior and edges, excludes outside", () => {
		const d = drag(10, 10, 110, 60);
		expect(insideSelection("rect", d, 50, 30)).toBe(true);
		expect(insideSelection("rect", d, 10, 10)).toBe(true); // edge counts
		expect(insideSelection("rect", d, 111, 30)).toBe(false);
	});

	it("circle: measures from the drag start, not the bounding box", () => {
		const d = drag(0, 0, 30, 40); // r = 50
		expect(insideSelection("circle", d, 18, 24)).toBe(true); // dist 30
		expect(insideSelection("circle", d, 60, 0)).toBe(false); // dist 60
		expect(insideSelection("circle", d, 49, 0)).toBe(true);
		// Bounding-box corner is OUTSIDE the circle — the refinement matters.
		expect(insideSelection("circle", d, 49, 49)).toBe(false);
	});
});

describe("overlayStyle", () => {
	it("rect overlay matches the normalized box with square corners", () => {
		expect(overlayStyle("rect", drag(100, 100, 20, 40))).toEqual({
			left: 20, top: 40, width: 80, height: 60, borderRadius: "0",
		});
	});

	it("circle overlay is the radius box rendered fully rounded", () => {
		expect(overlayStyle("circle", drag(0, 0, 30, 40))).toEqual({
			left: -50, top: -50, width: 100, height: 100, borderRadius: "50%",
		});
	});
});
