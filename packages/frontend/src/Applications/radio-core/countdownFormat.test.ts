import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { countdownFor } from "./countdownFormat";

const t = (iso: string) => new Date(iso).getTime();

// Minimal MediaItem factory — only the fields the helper reads matter. Same
// shape as stationGrouping.test.ts, deliberately.
function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 0,
		title: "t",
		full_title: "t",
		start_date: "2001-09-11T13:00:00.000Z",
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

describe("countdownFor", () => {
	const clip = item({ start_date: "2001-09-11T13:00:00.000Z" });

	it("reads as bare seconds under a minute", () => {
		expect(countdownFor(clip, t("2001-09-11T12:59:56.000Z"))).toBe("4s");
		expect(countdownFor(clip, t("2001-09-11T12:59:01.000Z"))).toBe("59s");
	});

	it("reads as MM:SS from one minute out", () => {
		expect(countdownFor(clip, t("2001-09-11T12:59:00.000Z"))).toBe("01:00");
		expect(countdownFor(clip, t("2001-09-11T12:56:47.000Z"))).toBe("03:13");
	});

	it("rounds up so it reaches zero exactly at the start, never early", () => {
		expect(countdownFor(clip, t("2001-09-11T12:59:59.500Z"))).toBe("1s");
		expect(countdownFor(clip, t("2001-09-11T13:00:00.000Z"))).toBe("0s");
	});

	it("clamps at zero once the start has passed", () => {
		expect(countdownFor(clip, t("2001-09-11T13:04:00.000Z"))).toBe("0s");
	});

	it("stays MM:SS right up to the last second under an hour", () => {
		// 59:59 is the widest the two-field form ever gets. One second later the
		// form has to change, so this is the assertion that pins where.
		expect(countdownFor(clip, t("2001-09-11T12:00:01.000Z"))).toBe("59:59");
	});

	it("grows an hours field at exactly 60 minutes", () => {
		// The bug: countdownLabel's minutes field is unbounded, so this read
		// "60:00" — indistinguishable at a glance from a minute past the hour.
		expect(countdownFor(clip, t("2001-09-11T12:00:00.000Z"))).toBe("01:00:00");
	});

	it("reads as HH:MM:SS for multi-hour waits", () => {
		expect(countdownFor(clip, t("2001-09-11T11:30:00.000Z"))).toBe("01:30:00");
		expect(countdownFor(clip, t("2001-09-11T10:59:47.000Z"))).toBe("02:00:13");
		// The 8h18m tape in the corpus is the longest wait the app can show.
		expect(countdownFor(clip, t("2001-09-11T04:42:00.000Z"))).toBe("08:18:00");
	});

	it("zero-pads minutes and seconds in both forms", () => {
		// Field widths that move as the clock runs down would reflow the header's
		// subject a character at a time, once a second.
		expect(countdownFor(clip, t("2001-09-11T12:57:05.000Z"))).toBe("02:55");
		expect(countdownFor(clip, t("2001-09-11T11:57:05.000Z"))).toBe("01:02:55");
	});
});
