import { PeaksWaveform } from "./PeaksWaveform";
import { thumbnailBuckets } from "./thumbnailBuckets";
import { usePeaksForSpan } from "./usePeaksForSpan";

const THUMB_BASE = "https://files.911realtime.org/thumbnails";
const OFFLINE = `${THUMB_BASE}/offline.jpg`;

/**
 * The expanded lane content shown for the selected bar: a strip of TV
 * thumbnails, or a radio waveform, across the entry's visible span.
 * `group`/`channel` come straight off the `TimelineBar` the caller already
 * laid out (`b.group`, `b.label` — `label` is the entry's `itemId`, i.e. the
 * channel/station slug) rather than a re-derived `MediaEntry`, since that is
 * all layoutBars ever carried.
 *
 * `startMs`/`endMs` are the *visible* span — the caller
 * (`PlaylistTimeline.tsx`) intersects the entry's own window with the timeline
 * scroll viewport before calling, and renders nothing at all when that
 * intersection is empty. This component never sees the entry's full extent, so
 * zooming and panning walk the strip through the footage rather than
 * re-sampling the same ten days. `viewportPx` is the scroll viewport's width,
 * which is how much room the sticky TV strip has to lay tiles out in.
 *
 * `flights` renders nothing here.
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
	if (group === "radio") {
		return <RadioLanePreview station={channel} startMs={startMs} endMs={endMs} />;
	}
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

/**
 * A radio entry names a station and a time window, not a single recording
 * (`playlistTypes.ts`: a `MediaEntry`'s `itemId` is a station slug for radio).
 * The window can span several `mp3_items` rows or none, so the preview is
 * assembled from whatever aired in it, each drawn at its own time position —
 * the same shape as the TV thumbnail strip above, which is also
 * time-positioned rather than item-positioned.
 *
 * Unlike that strip, this preview is `position: relative`, not sticky: it is
 * a time-positioned overlay whose slots must stay aligned with the timeline
 * beneath them as the user scrolls, rather than a summary that should stay in
 * view.
 */
function RadioLanePreview({
	station,
	startMs,
	endMs,
}: {
	station: string;
	startMs: number;
	endMs: number;
}) {
	const spans = usePeaksForSpan(station, startMs, endMs);
	// Nothing aired, or compute-peaks has not reached these recordings yet:
	// show nothing rather than an empty box, so a missing preview stays quiet.
	if (spans.length === 0) return null;
	const total = endMs - startMs;
	return (
		<div className="playlistTimelinePreview playlistTimelinePreviewRadio">
			{spans.map((s) => (
				<div
					key={s.startMs}
					className="playlistTimelineWaveformSlot"
					style={{
						left: `${((s.startMs - startMs) / total) * 100}%`,
						width: `${((s.endMs - s.startMs) / total) * 100}%`,
					}}
				>
					<PeaksWaveform peaks={s.peaks} height={40} />
				</div>
			))}
		</div>
	);
}
