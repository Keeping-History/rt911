import { thumbnailBuckets } from "./thumbnailBuckets";

const THUMB_BASE = "https://files.911realtime.org/thumbnails";
const OFFLINE = `${THUMB_BASE}/offline.jpg`;

/**
 * The expanded lane content shown for the selected bar: a strip of TV
 * thumbnails across the entry's visible span. `group`/`channel` come straight
 * off the `TimelineBar` the caller already laid out (`b.group`, `b.label` —
 * `label` is the entry's `itemId`, i.e. the channel slug) rather than a
 * re-derived `MediaEntry`, since that is all layoutBars ever carried.
 *
 * `startMs`/`endMs` are the *visible* span — the caller
 * (`PlaylistTimeline.tsx`) intersects the entry's own window with the timeline
 * scroll viewport before calling, and renders nothing at all when that
 * intersection is empty. This component never sees the entry's full extent, so
 * zooming and panning walk the strip through the footage rather than
 * re-sampling the same ten days. `viewportPx` is the scroll viewport's width,
 * which is how much room the sticky strip has to lay tiles out in.
 *
 * Radio gets its own branch in a later task; every other group renders
 * nothing here.
 */
export function LanePreview({
	group,
	channel,
	startMs,
	endMs,
	viewportPx,
}: {
	group: "tv" | "radio" | "flights";
	channel: string;
	startMs: number;
	endMs: number;
	viewportPx: number;
}) {
	if (group !== "tv") return null;

	const buckets = thumbnailBuckets({ startMs, endMs, viewportPx });
	if (buckets.length === 0) return null;

	const slug = channel.toLowerCase();
	return (
		// Sticky for the same reason the label is: the lane is far wider than
		// the viewport once zoomed, so content anchored to the lane's left edge
		// would sit off-screen.
		<div className="playlistTimelinePreview">
			{buckets.map((ts) => (
				<img
					key={ts}
					className="playlistTimelinePreviewThumb"
					src={`${THUMB_BASE}/${slug}/${ts}.jpg`}
					onError={(e) => {
						e.currentTarget.src = OFFLINE;
					}}
					alt=""
				/>
			))}
		</div>
	);
}
