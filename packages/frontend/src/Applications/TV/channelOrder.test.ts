import { describe, expect, it } from "vitest";
import {
	applyReorder,
	insertionIndexFromX,
	sortByChannelOrder,
} from "./channelOrder";

const item = (source: string) => ({ source });

describe("sortByChannelOrder", () => {
	it("orders items by the saved order", () => {
		const items = [item("A"), item("B"), item("C")];
		expect(sortByChannelOrder(items, ["C", "A", "B"]).map((i) => i.source)).toEqual([
			"C",
			"A",
			"B",
		]);
	});

	it("appends unknown sources after ordered ones, keeping input order", () => {
		const items = [item("X"), item("B"), item("Y"), item("A")];
		expect(sortByChannelOrder(items, ["A", "B"]).map((i) => i.source)).toEqual([
			"A",
			"B",
			"X",
			"Y",
		]);
	});

	it("returns items unchanged for an empty order", () => {
		const items = [item("B"), item("A")];
		expect(sortByChannelOrder(items, []).map((i) => i.source)).toEqual(["B", "A"]);
	});

	it("ignores order entries with no matching item", () => {
		const items = [item("A")];
		expect(sortByChannelOrder(items, ["Z", "A"]).map((i) => i.source)).toEqual(["A"]);
	});
});

describe("insertionIndexFromX", () => {
	// Three 100px thumbnails at x = 0, 100, 200 → midpoints 50, 150, 250.
	const rects = [
		{ left: 0, width: 100 },
		{ left: 100, width: 100 },
		{ left: 200, width: 100 },
	];

	it("returns 0 before the first midpoint", () => {
		expect(insertionIndexFromX(rects, 10)).toBe(0);
	});

	it("returns the index between two midpoints", () => {
		expect(insertionIndexFromX(rects, 120)).toBe(1);
	});

	it("returns rects.length past the last midpoint", () => {
		expect(insertionIndexFromX(rects, 900)).toBe(3);
	});

	it("returns 0 for an empty strip", () => {
		expect(insertionIndexFromX([], 50)).toBe(0);
	});
});

describe("applyReorder", () => {
	const sources = ["A", "B", "C", "D"];

	it("moves an item forward (insertion index after removal)", () => {
		expect(applyReorder(sources, 0, 3)).toEqual(["B", "C", "A", "D"]);
	});

	it("moves an item backward", () => {
		expect(applyReorder(sources, 3, 1)).toEqual(["A", "D", "B", "C"]);
	});

	it("moves an item to the very end", () => {
		expect(applyReorder(sources, 1, 4)).toEqual(["A", "C", "D", "B"]);
	});

	it("returns the same reference when dropping onto its own slot", () => {
		expect(applyReorder(sources, 1, 1)).toBe(sources);
		expect(applyReorder(sources, 1, 2)).toBe(sources); // gap just after itself
	});
});
