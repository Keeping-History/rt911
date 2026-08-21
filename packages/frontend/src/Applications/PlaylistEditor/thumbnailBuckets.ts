/**
 * Which thumbnails to show for an entry's visible span.
 *
 * "Visible span" is literal: `startMs`/`endMs` are the intersection of the
 * entry's window with the timeline's scroll viewport, computed by the caller
 * (`PlaylistTimeline.tsx`). That is what makes zoom mean something here — the
 * tile budget is fixed by the viewport width, so a narrower visible window
 * spends it on a denser, closer-spaced run of images instead of six stills
 * forty hours apart.
 *
 * Thumbnails exist only on a 30-second grid (see TV/ThumbnailTile.tsx), so the
 * count is bounded twice: by how many tiles fit, and by how many distinct
 * images the span actually contains. The second bound is the important one — a
 * two-minute entry has four thumbnails no matter how wide the window is, and
 * requesting more would render duplicates or fall back to offline.jpg, which
 * reads as broken rather than as "this is all there is".
 */
export const BUCKET_SECONDS = 30;

const DEFAULT_TILE_PX = 96;

export function thumbnailBuckets({
	startMs,
	endMs,
	viewportPx,
	tilePx = DEFAULT_TILE_PX,
}: {
	startMs: number;
	endMs: number;
	viewportPx: number;
	tilePx?: number;
}): number[] {
	const fit = Math.floor(viewportPx / tilePx);
	if (fit < 1 || endMs <= startMs) return [];

	const startBucket = Math.floor(startMs / 1000 / BUCKET_SECONDS);
	const endBucket = Math.floor((endMs - 1) / 1000 / BUCKET_SECONDS);
	const available = endBucket - startBucket + 1;

	const count = Math.min(fit, available);
	const stride = available / count;

	// Sample from a stride-aligned grid anchored at bucket 0 (i.e. multiples of
	// `stride`), not offsets counted from `startBucket`. A pan at a fixed zoom
	// keeps `stride` unchanged (same span length, same tile budget), so the
	// grid itself doesn't move — only the window sliding across it does, which
	// drops the points that scrolled out and adds the ones newly in range
	// without renumbering everything in between. Re-basing on `startBucket`
	// (the previous behaviour) shifted every sampled index by the same
	// sub-bucket amount on every call, so scrolling by even a few pixels
	// selected an entirely different set of timestamps — the caller keys
	// `<img>` nodes by timestamp (`LanePreview.tsx`), so that churn unmounted
	// and re-fetched the whole strip on every scroll tick instead of just its
	// edges.
	const firstGridIndex = Math.ceil(startBucket / stride);

	const out: number[] = [];
	for (let i = 0; i < count; i++) {
		const bucket = Math.floor((firstGridIndex + i) * stride);
		out.push(bucket * BUCKET_SECONDS);
	}
	return out;
}
