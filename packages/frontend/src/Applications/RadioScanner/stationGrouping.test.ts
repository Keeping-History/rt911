import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import {
	activeSegments,
	calcSeekSeconds,
	groupStations,
	primarySegment,
	type Station,
} from "./stationGrouping";

// Minimal MediaItem factory — only the fields the helpers read matter.
function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 0,
		title: "t",
		full_title: "t",
		start_date: "2001-09-11T12:40:00.000Z",
		url: "u",
		format: "mp3",
		approved: 1,
		mute: 0,
		volume: 1,
		jump: 0,
		trim: 0,
		...over,
	};
}

describe("groupStations", () => {
	it("groups items by source, preserving first-seen order", () => {
		const items = [
			item({ id: 1, source: "ATC" }),
			item({ id: 2, source: "Rutgers" }),
			item({ id: 3, source: "ATC" }),
		];
		const stations = groupStations(items);
		expect(stations.map((s) => s.key)).toEqual(["ATC", "Rutgers"]);
		expect(stations[0].items.map((i) => i.id)).toEqual([1, 3]);
		expect(stations[0].label).toBe("ATC");
	});

	it("falls back to title when source is blank/empty", () => {
		const items = [item({ id: 1, source: "", title: "Lonely" }), item({ id: 2, source: undefined, title: "Lonely" })];
		const stations = groupStations(items);
		expect(stations).toHaveLength(1);
		expect(stations[0].key).toBe("Lonely");
		expect(stations[0].items.map((i) => i.id)).toEqual([1, 2]);
	});
});

describe("activeSegments", () => {
	const t = (s: string) => new Date(s).getTime();
	const station = (items: MediaItem[]): Station => ({ key: "k", label: "k", items });

	it("returns exactly one in-window segment for sequential data (playlist)", () => {
		const s = station([
			item({ id: 1, start_date: "2001-09-11T12:40:00Z", end_date: "2001-09-11T12:45:00Z" }),
			item({ id: 2, start_date: "2001-09-11T12:45:00Z", end_date: "2001-09-11T12:50:00Z" }),
		]);
		expect(activeSegments(s, t("2001-09-11T12:42:00Z")).map((i) => i.id)).toEqual([1]);
		expect(activeSegments(s, t("2001-09-11T12:47:00Z")).map((i) => i.id)).toEqual([2]);
	});

	it("returns all overlapping in-window segments (mix)", () => {
		const s = station([
			item({ id: 1, start_date: "2001-09-11T12:40:00Z", end_date: "2001-09-11T12:50:00Z" }),
			item({ id: 2, start_date: "2001-09-11T12:45:00Z", end_date: "2001-09-11T12:55:00Z" }),
		]);
		expect(activeSegments(s, t("2001-09-11T12:47:00Z")).map((i) => i.id)).toEqual([1, 2]);
	});

	it("returns nothing in a gap, before first, or after last", () => {
		const s = station([item({ id: 1, start_date: "2001-09-11T12:40:00Z", end_date: "2001-09-11T12:45:00Z" })]);
		expect(activeSegments(s, t("2001-09-11T12:39:00Z"))).toEqual([]); // before
		expect(activeSegments(s, t("2001-09-11T12:46:00Z"))).toEqual([]); // after
	});

	it("derives end from calc_duration when end_date is absent", () => {
		const s = station([item({ id: 1, start_date: "2001-09-11T12:40:00Z", calc_duration: 300 })]); // 5 min
		expect(activeSegments(s, t("2001-09-11T12:44:00Z")).map((i) => i.id)).toEqual([1]);
		expect(activeSegments(s, t("2001-09-11T12:46:00Z"))).toEqual([]);
	});

	it("treats a segment with no end and no duration as in-window from its start", () => {
		const s = station([item({ id: 1, start_date: "2001-09-11T12:40:00Z" })]);
		expect(activeSegments(s, t("2001-09-11T12:39:00Z"))).toEqual([]);
		expect(activeSegments(s, t("2001-09-11T13:40:00Z")).map((i) => i.id)).toEqual([1]);
	});

	it("parses tz-less datetimes as UTC", () => {
		const s = station([item({ id: 1, start_date: "2001-09-11T12:40:00", end_date: "2001-09-11T12:45:00" })]);
		expect(activeSegments(s, t("2001-09-11T12:42:00Z")).map((i) => i.id)).toEqual([1]);
	});
});

describe("primarySegment", () => {
	it("returns the segment with the latest start_date", () => {
		const a = item({ id: 1, start_date: "2001-09-11T12:40:00Z" });
		const b = item({ id: 2, start_date: "2001-09-11T12:45:00Z" });
		expect(primarySegment([a, b])?.id).toBe(2);
	});
	it("returns null for an empty list", () => {
		expect(primarySegment([])).toBeNull();
	});
});

describe("calcSeekSeconds", () => {
	it("returns clock-minus-start plus jump, floored at 0", () => {
		const it1 = item({ start_date: "2001-09-11T12:40:00Z", jump: 2 });
		expect(calcSeekSeconds(it1, new Date("2001-09-11T12:40:30Z").getTime())).toBe(32);
		expect(calcSeekSeconds(it1, new Date("2001-09-11T12:39:00Z").getTime())).toBe(0); // floored
	});
});
