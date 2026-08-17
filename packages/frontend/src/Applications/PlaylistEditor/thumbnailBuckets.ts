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

	const out: number[] = [];
	for (let i = 0; i < count; i++) {
		const bucket = startBucket + Math.floor(i * stride);
		out.push(bucket * BUCKET_SECONDS);
	}
	return out;
}
