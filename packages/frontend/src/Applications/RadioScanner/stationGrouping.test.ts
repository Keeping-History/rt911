import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import {
	activeSegments,
	calcSeekSeconds,
	countdownLabel,
	groupStations,
	mergeWithSources,
	previousSegments,
	primarySegment,
	sortStations,
	startTimeLabel,
	type Station,
	upcomingSegments,
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

describe("countdownLabel", () => {
	const t = (s: string) => new Date(s).getTime();

	it("formats minutes:seconds until the item's start", () => {
		const it1 = item({ start_date: "2001-09-11T12:31:32Z" });
		expect(countdownLabel(it1, t("2001-09-11T12:30:00Z"))).toBe("01:32");
	});

	it("pads both fields and counts total minutes past an hour", () => {
		const it1 = item({ start_date: "2001-09-11T13:45:07Z" });
		expect(countdownLabel(it1, t("2001-09-11T12:30:00Z"))).toBe("75:07");
		const it2 = item({ start_date: "2001-09-11T12:30:05Z" });
		expect(countdownLabel(it2, t("2001-09-11T12:30:00Z"))).toBe("00:05");
	});

	it("rounds up mid-second so it reaches 00:00 exactly at start", () => {
		const it1 = item({ start_date: "2001-09-11T12:31:00Z" });
		expect(countdownLabel(it1, t("2001-09-11T12:30:59.400Z"))).toBe("00:01");
		expect(countdownLabel(it1, t("2001-09-11T12:31:00Z"))).toBe("00:00");
	});

	it("clamps to 00:00 once the start has passed", () => {
		const it1 = item({ start_date: "2001-09-11T12:30:00Z" });
		expect(countdownLabel(it1, t("2001-09-11T12:31:00Z"))).toBe("00:00");
	});
});

describe("startTimeLabel", () => {
	it("formats the start instant in the display timezone", () => {
		const it1 = item({ start_date: "2001-09-11T12:52:00.000Z" });
		expect(startTimeLabel(it1, -4)).toBe("9/11, 8:52 AM");
	});

	it("treats a tz-less Directus datetime as UTC", () => {
		const it1 = item({ start_date: "2001-09-11 12:52:00" });
		expect(startTimeLabel(it1, -4)).toBe("9/11, 8:52 AM");
	});

	it("crosses the date line when the shift lands on another day", () => {
		const it1 = item({ start_date: "2001-09-12T01:30:00.000Z" });
		expect(startTimeLabel(it1, -4)).toBe("9/11, 9:30 PM");
		expect(startTimeLabel(it1, 0)).toBe("9/12, 1:30 AM");
	});
});

describe("upcomingSegments", () => {
	const t = (s: string) => new Date(s).getTime();
	const station = (key: string): Station => ({ key, label: key, items: [] });

	it("returns items in the future for the matching station, sorted earliest-first", () => {
		const upcoming = [
			item({ id: 1, source: "ATC", start_date: "2001-09-11T13:00:00Z" }),
			item({ id: 2, source: "ATC", start_date: "2001-09-11T12:50:00Z" }),
			item({ id: 3, source: "Rutgers", start_date: "2001-09-11T13:10:00Z" }),
		];
		const now = t("2001-09-11T12:45:00Z");
		const result = upcomingSegments(station("ATC"), upcoming, now);
		expect(result.map((i) => i.id)).toEqual([2, 1]);
	});

	it("excludes items whose start_date is not in the future", () => {
		const upcoming = [
			item({ id: 1, source: "ATC", start_date: "2001-09-11T12:40:00Z" }),
		];
		const now = t("2001-09-11T12:45:00Z");
		expect(upcomingSegments(station("ATC"), upcoming, now)).toEqual([]);
	});

	it("limits results to count", () => {
		const upcoming = Array.from({ length: 8 }, (_, i) =>
			item({ id: i + 1, source: "ATC", start_date: `2001-09-11T1${i}:00:00Z` }),
		).filter((x) => x.start_date > "2001-09-11T12:00:00Z");
		const now = t("2001-09-11T09:00:00Z");
		expect(upcomingSegments(station("ATC"), upcoming, now, 3)).toHaveLength(3);
	});

	it("returns empty for empty upcoming list", () => {
		expect(upcomingSegments(station("ATC"), [], new Date("2001-09-11T12:00:00Z").getTime())).toEqual([]);
	});
});

describe("previousSegments", () => {
	const t = (s: string) => new Date(s).getTime();
	const station = (key: string): Station => ({ key, label: key, items: [] });

	it("returns ended items for the matching station, most recent first", () => {
		const history = [
			item({ id: 1, source: "ATC", start_date: "2001-09-11T12:00:00Z", end_date: "2001-09-11T12:10:00Z" }),
			item({ id: 2, source: "ATC", start_date: "2001-09-11T12:20:00Z", end_date: "2001-09-11T12:30:00Z" }),
			item({ id: 3, source: "Rutgers", start_date: "2001-09-11T12:00:00Z", end_date: "2001-09-11T12:05:00Z" }),
		];
		const now = t("2001-09-11T12:45:00Z");
		const result = previousSegments(station("ATC"), history, now);
		expect(result.map((i) => i.id)).toEqual([2, 1]);
	});

	it("excludes currently active items (end_date in the future)", () => {
		const history = [
			item({ id: 1, source: "ATC", start_date: "2001-09-11T12:00:00Z", end_date: "2001-09-11T12:50:00Z" }),
		];
		const now = t("2001-09-11T12:45:00Z");
		expect(previousSegments(station("ATC"), history, now)).toEqual([]);
	});

	it("excludes items with no knowable end", () => {
		const history = [item({ id: 1, source: "ATC", start_date: "2001-09-11T12:00:00Z" })];
		const now = t("2001-09-11T12:45:00Z");
		expect(previousSegments(station("ATC"), history, now)).toEqual([]);
	});

	it("uses calc_duration when end_date is absent", () => {
		const history = [
			item({ id: 1, source: "ATC", start_date: "2001-09-11T12:00:00Z", calc_duration: 300 }),
		];
		const now = t("2001-09-11T12:10:00Z");
		expect(previousSegments(station("ATC"), history, now).map((i) => i.id)).toEqual([1]);
	});

	it("returns the full history with no cap", () => {
		const history = Array.from({ length: 8 }, (_, i) =>
			item({ id: i + 1, source: "ATC", start_date: `2001-09-11T${String(i).padStart(2, "0")}:00:00Z`, end_date: `2001-09-11T${String(i).padStart(2, "0")}:05:00Z` }),
		);
		const now = t("2001-09-11T12:00:00Z");
		expect(previousSegments(station("ATC"), history, now)).toHaveLength(8);
	});
});

describe("mergeWithSources", () => {
	it("lists all audioSources even when no items are present", () => {
		const stations = mergeWithSources(["ATC", "Rutgers"], []);
		expect(stations.map((s) => s.key)).toEqual(["ATC", "Rutgers"]);
		expect(stations.every((s) => s.items.length === 0)).toBe(true);
	});

	it("overlays active items onto matching sources", () => {
		const i = item({ id: 1, source: "ATC" });
		const stations = mergeWithSources(["ATC", "Rutgers"], [i]);
		expect(stations.find((s) => s.key === "ATC")?.items.map((x) => x.id)).toEqual([1]);
		expect(stations.find((s) => s.key === "Rutgers")?.items).toEqual([]);
	});

	it("preserves audioSources order, appending unknown sources at the end", () => {
		const i = item({ id: 1, source: "NewStation" });
		const stations = mergeWithSources(["ATC", "Rutgers"], [i]);
		expect(stations.map((s) => s.key)).toEqual(["ATC", "Rutgers", "NewStation"]);
	});

	it("returns empty list when both audioSources and items are empty", () => {
		expect(mergeWithSources([], [])).toEqual([]);
	});
});

describe("sortStations", () => {
	const nowMs = new Date("2001-09-11T12:45:00Z").getTime();
	const active = item({ start_date: "2001-09-11T12:40:00Z", end_date: "2001-09-11T12:50:00Z" });
	const station = (key: string, items: MediaItem[] = []): Station => ({ key, label: key, items });

	it("pins WINS then WCBS to the front even when offline", () => {
		const stations = [
			station("ATC", [active]),
			station("WCBS"),
			station("Rutgers"),
			station("WINS"),
		];
		expect(sortStations(stations, nowMs).map((s) => s.key)).toEqual([
			"WINS",
			"WCBS",
			"ATC",
			"Rutgers",
		]);
	});

	it("orders the remaining stations online-first, keeping relative order", () => {
		const stations = [
			station("Rutgers"),
			station("NY ATC", [active]),
			station("Newark ATC", [active]),
			station("Scanner"),
		];
		expect(sortStations(stations, nowMs).map((s) => s.key)).toEqual([
			"NY ATC",
			"Newark ATC",
			"Rutgers",
			"Scanner",
		]);
	});

	it("omits pinned stations that are absent from the list", () => {
		const stations = [station("WCBS"), station("ATC", [active])];
		expect(sortStations(stations, nowMs).map((s) => s.key)).toEqual(["WCBS", "ATC"]);
	});
});
