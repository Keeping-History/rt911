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
});
