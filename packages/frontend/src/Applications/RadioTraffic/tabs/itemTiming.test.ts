import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../../Providers/MediaStream/MediaStreamContext";
import { durationLabel, itemTiming, wallClockLabel } from "./itemTiming";

/** A minimal wire-shaped item; each test overrides only the timing fields. */
function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 1,
		title: "ZBW",
		full_title: "Boston Center — sector 20",
		start_date: "2001-09-11 12:46:31",
		url: "https://files.example/clip.mp3",
		format: "mp3",
		approved: 1,
		mute: 0,
		volume: 1,
		jump: 0,
		trim: 0,
		...overrides,
	};
}

describe("itemTiming", () => {
	it("reads the end from end_date when the row has one", () => {
		const timing = itemTiming(
			makeItem({ end_date: "2001-09-11 12:49:44", calc_duration: 999 }),
		);
		expect(timing.endMs).toBe(Date.parse("2001-09-11T12:49:44Z"));
		// end_date wins over calc_duration, matching the lane predicates — the
		// panel must not claim a duration the lane it sits in disagrees with.
		expect(timing.durationSec).toBe(193);
	});

	it("derives the end from calc_duration when there is no end_date", () => {
		const timing = itemTiming(makeItem({ calc_duration: 193 }));
		expect(timing.endMs).toBe(Date.parse("2001-09-11T12:49:44Z"));
		expect(timing.durationSec).toBe(193);
	});

	it("reports an unknown end rather than guessing one", () => {
		const timing = itemTiming(makeItem());
		expect(timing.endMs).toBeNull();
		expect(timing.durationSec).toBeNull();
	});

	it("treats a tz-less Directus timestamp as UTC, not browser-local", () => {
		// The bug stationGrouping's toMs exists to prevent: a bare new Date() on
		// "2001-09-11 12:46:31" is read in the reader's own offset, shifting the
		// card's clock by however many hours the visitor happens to be from UTC.
		expect(itemTiming(makeItem()).startMs).toBe(Date.parse("2001-09-11T12:46:31Z"));
	});

	it("reports an unparseable start as unknown instead of NaN", () => {
		const timing = itemTiming(makeItem({ start_date: "not a date" }));
		expect(timing.startMs).toBeNull();
		expect(timing.durationSec).toBeNull();
	});
});

describe("wallClockLabel", () => {
	it("renders the instant in the desktop's display timezone", () => {
		// 12:46:31 UTC at offset -4 is the 8:46:31 AM everyone knows.
		// \s rather than a literal space: modern ICU emits U+202F before AM/PM.
		expect(wallClockLabel(Date.parse("2001-09-11T12:46:31Z"), -4)).toMatch(
			/^8:46:31\sAM$/,
		);
	});

	it("shifts with the offset rather than the browser's own zone", () => {
		expect(wallClockLabel(Date.parse("2001-09-11T12:46:31Z"), 0)).toMatch(
			/^12:46:31\sPM$/,
		);
	});

	it("has no label for an unknown instant", () => {
		expect(wallClockLabel(null, -4)).toBeNull();
	});
});

describe("durationLabel", () => {
	it("renders MM:SS", () => {
		expect(durationLabel(193)).toBe("03:13");
	});

	it("keeps counting past an hour rather than rolling over", () => {
		// A 90-minute clip must not read as "30:00" — the card would be lying
		// about a recording three times longer than it claims.
		expect(durationLabel(5400)).toBe("90:00");
	});

	it("renders a zero-length clip rather than nothing", () => {
		expect(durationLabel(0)).toBe("00:00");
	});

	it("has no label for an unknown duration", () => {
		expect(durationLabel(null)).toBeNull();
	});
});
