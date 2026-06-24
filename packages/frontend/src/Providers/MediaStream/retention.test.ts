import { describe, expect, it } from "vitest";
import type { MediaItem, PagerItem } from "./MediaStreamContext";
import { INSTANT_RETENTION_MS, keepMediaItem, keepPagerItem } from "./retention";

const iso = (ms: number) => new Date(ms).toISOString();

// Minimal MediaItem factory — only the time fields drive retention.
const media = (over: Partial<MediaItem>): MediaItem => ({
	id: 1,
	title: "",
	full_title: "",
	start_date: "",
	url: "",
	format: "mp3",
	approved: 1,
	mute: 0,
	volume: 1,
	jump: 0,
	trim: 0,
	...over,
});

const pager = (over: Partial<PagerItem>): PagerItem => ({
	id: 1,
	start_date: "",
	message: "",
	...over,
});

describe("keepMediaItem", () => {
	const now = 10_000_000;

	it("keeps a durational station that is currently live", () => {
		const item = media({
			start_date: iso(now - 60_000),
			end_date: iso(now + 60_000),
		});
		expect(keepMediaItem(item, now)).toBe(true);
	});

	it("drops a durational station that has ended (trailing edge)", () => {
		const item = media({
			start_date: iso(now - 120_000),
			end_date: iso(now - 60_000),
		});
		expect(keepMediaItem(item, now)).toBe(false);
	});

	// The rewind bug: a station that started after the rewound clock must be
	// dropped even though its end_date is still in the future.
	it("drops a station whose start is in the future after a backward seek", () => {
		const item = media({
			start_date: iso(now + 30_000), // hasn't started at `now`
			end_date: iso(now + 90_000), // but ends later → old code kept it
		});
		expect(keepMediaItem(item, now)).toBe(false);
	});

	it("drops an open-ended station rewound to before its start", () => {
		const item = media({ start_date: iso(now + 30_000) }); // no end_date
		expect(keepMediaItem(item, now)).toBe(false);
	});

	it("keeps an open-ended station once it has started", () => {
		const item = media({ start_date: iso(now - 1) });
		expect(keepMediaItem(item, now)).toBe(true);
	});

	it("retains an instant item within the retention window after its start", () => {
		const t = iso(now - 60_000);
		const item = media({ start_date: t, end_date: t });
		expect(keepMediaItem(item, now)).toBe(true);
	});

	it("drops an instant item rewound to before its start", () => {
		const t = iso(now + 60_000);
		const item = media({ start_date: t, end_date: t });
		expect(keepMediaItem(item, now)).toBe(false);
	});
});

describe("keepPagerItem", () => {
	const now = 10_000_000;

	it("keeps a pager within the retention window", () => {
		expect(keepPagerItem(pager({ start_date: iso(now - 1_000) }), now)).toBe(true);
	});

	it("drops a pager past the retention window", () => {
		expect(
			keepPagerItem(pager({ start_date: iso(now - INSTANT_RETENTION_MS - 1) }), now),
		).toBe(false);
	});

	it("drops a pager whose start is in the future after a rewind", () => {
		expect(keepPagerItem(pager({ start_date: iso(now + 1_000) }), now)).toBe(false);
	});
});
