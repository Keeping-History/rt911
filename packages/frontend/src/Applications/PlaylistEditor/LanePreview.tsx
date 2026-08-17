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
