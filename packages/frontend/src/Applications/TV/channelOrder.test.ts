import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { moveChannel, orderChannels } from "./channelOrder";

const item = (id: number, source: string) => ({ id, source }) as unknown as MediaItem;

describe("orderChannels", () => {
	it("puts saved channels first, in the saved order", () => {
		const items = [item(1, "WABC"), item(2, "WNBC"), item(3, "WCBS")];
		expect(orderChannels(items, ["WCBS", "WABC"]).map((i) => i.source)).toEqual([
			"WCBS",
			"WABC",
			"WNBC",
		]);
	});

	it("appends unknown channels preserving their incoming relative order", () => {
		const items = [item(1, "WABC"), item(2, "WNBC"), item(3, "WCBS")];
		// Incoming order of the unsaved ones (WABC, WNBC) must be preserved after WCBS.
		expect(orderChannels(items, ["WCBS"]).map((i) => i.source)).toEqual([
			"WCBS",
			"WABC",
			"WNBC",
		]);
	});

	it("skips saved slugs that have no matching item", () => {
		const items = [item(1, "WABC")];
		expect(orderChannels(items, ["GONE", "WABC"]).map((i) => i.source)).toEqual(["WABC"]);
	});

	it("is stable when item ids change but sources do not (program rollover)", () => {
		const before = [item(1, "WABC"), item(2, "WNBC")];
		const after = [item(99, "WABC"), item(98, "WNBC")];
		const order = ["WNBC", "WABC"];
		expect(orderChannels(before, order).map((i) => i.source)).toEqual(
			orderChannels(after, order).map((i) => i.source),
		);
	});

	it("returns items unchanged when there is no saved order", () => {
		const items = [item(1, "WABC"), item(2, "WNBC")];
		expect(orderChannels(items, []).map((i) => i.source)).toEqual(["WABC", "WNBC"]);
	});

	it("ignores items with no source rather than throwing", () => {
		const items = [item(1, "WABC"), { id: 2 } as unknown as MediaItem];
		expect(orderChannels(items, ["WABC"]).length).toBe(2);
	});
});

describe("moveChannel", () => {
	it("materializes the visible order on the first drag", () => {
		// Saved order is empty; dragging WCBS onto WABC must keep WNBC in place.
		expect(moveChannel([], ["WABC", "WNBC", "WCBS"], "WCBS", "WABC")).toEqual([
			"WCBS",
			"WABC",
			"WNBC",
		]);
	});

	it("moves a channel forward, inserting before the target", () => {
		expect(moveChannel(["A", "B", "C"], ["A", "B", "C"], "A", "C")).toEqual(["B", "C", "A"]);
	});

	it("moves a channel backward, inserting before the target", () => {
		expect(moveChannel(["A", "B", "C"], ["A", "B", "C"], "C", "B")).toEqual(["A", "C", "B"]);
	});

	it("is a no-op when source and target are the same", () => {
		expect(moveChannel(["A", "B"], ["A", "B"], "A", "A")).toEqual(["A", "B"]);
	});

	it("does not mutate the input array", () => {
		const order = ["A", "B"];
		moveChannel(order, ["A", "B"], "B", "A");
		expect(order).toEqual(["A", "B"]);
	});
});
