import { describe, expect, it } from "vitest";
import { BUCKET_SECONDS, thumbnailBuckets } from "./thumbnailBuckets";

const at = (h: number, m: number, s = 0) => Date.UTC(2001, 8, 11, h, m, s);

describe("thumbnailBuckets", () => {
	it("fills the available width when enough buckets exist", () => {
		// One hour of span, 800px of viewport, 100px tiles => 8 tiles.
		const out = thumbnailBuckets({
			startMs: at(12, 0), endMs: at(13, 0), viewportPx: 800, tilePx: 100,
		});
		expect(out).toHaveLength(8);
	});

	it("caps at the buckets a short span actually contains", () => {
		// Thumbnails exist every 30s, so two minutes holds four of them however
		// much room there is. Asking for more would return duplicates or 404s.
		const out = thumbnailBuckets({
			startMs: at(12, 0), endMs: at(12, 2), viewportPx: 2000, tilePx: 100,
		});
		expect(out).toHaveLength(4);
	});

	it("returns one thumbnail for a span shorter than a bucket", () => {
		const out = thumbnailBuckets({
			startMs: at(12, 0), endMs: at(12, 0, 10), viewportPx: 800, tilePx: 100,
		});
		expect(out).toHaveLength(1);
	});

	it("snaps every timestamp to the 30s grid the images exist at", () => {
		const out = thumbnailBuckets({
			startMs: at(12, 0, 17), endMs: at(12, 5), viewportPx: 400, tilePx: 100,
		});
		for (const ts of out) expect(ts % BUCKET_SECONDS).toBe(0);
	});

	it("returns nothing when there is no room to draw", () => {
		expect(thumbnailBuckets({
			startMs: at(12, 0), endMs: at(13, 0), viewportPx: 0, tilePx: 100,
		})).toEqual([]);
	});

	it("keeps the sampled set stable when the window pans by less than one stride", () => {
		// Two hours of span, 8 tiles => stride = 240 buckets / 8 = 30 buckets =
		// 900s. A pan of one bucket (30s) is far smaller than that stride, so
		// this should only ever drop/add an edge, not re-sample the whole strip
		// (the bug: re-basing buckets on `startBucket` shifted every sampled
		// index on every call, so React remounted and re-fetched every `<img>`
		// on the tiniest scroll).
		const base = { viewportPx: 800, tilePx: 100 };
		const before = thumbnailBuckets({ startMs: at(12, 0), endMs: at(14, 0), ...base });
		const after = thumbnailBuckets({
			startMs: at(12, 0, 30), endMs: at(14, 0, 30), ...base,
		});

		expect(before).toHaveLength(8);
		expect(after).toHaveLength(8);

		const shared = after.filter((ts) => before.includes(ts));
		// All but (at most) the edge that scrolled out should survive.
		expect(shared.length).toBeGreaterThanOrEqual(before.length - 1);
		// The window DID move — this isn't just two calls landing on an
		// identical grid by coincidence.
		expect(after).not.toEqual(before);
	});

	it("still fills the width after a large pan (control for the stability test)", () => {
		// Same shape as above but panned by far more than one stride — every
		// bucket is free to change, proving the stability assertion above is
		// actually exercising something rather than always passing.
		const base = { viewportPx: 800, tilePx: 100 };
		const before = thumbnailBuckets({ startMs: at(12, 0), endMs: at(14, 0), ...base });
		const after = thumbnailBuckets({ startMs: at(20, 0), endMs: at(22, 0), ...base });

		expect(before).toHaveLength(8);
		expect(after).toHaveLength(8);
		expect(after.some((ts) => before.includes(ts))).toBe(false);
	});
});
