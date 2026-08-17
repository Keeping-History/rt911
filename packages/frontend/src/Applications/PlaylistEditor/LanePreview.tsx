import { PeaksWaveform } from "./PeaksWaveform";
import { thumbnailBuckets } from "./thumbnailBuckets";
import { msToFraction, type TimelineBounds } from "./timelineLayout";
import { usePeaksForSpan } from "./usePeaksForSpan";

const THUMB_BASE = "https://files.911realtime.org/thumbnails";
const OFFLINE = `${THUMB_BASE}/offline.jpg`;

/** Matches `.playlistTimelinePreviewRadio`'s height in PlaylistEditor.scss. */
const WAVEFORM_HEIGHT = 40;

/**
 * The expanded lane content shown for the selected bar: a strip of TV
 * thumbnails, or a radio waveform.
 * `group`/`channel` come straight off the `TimelineBar` the caller already
 * laid out (`b.group`, `b.label` — `label` is the entry's `itemId`, i.e. the
 * channel/station slug) rather than a re-derived `MediaEntry`, since that is
 * all layoutBars ever carried.
 *
 * The two branches want different spans, and conflating them is the bug this
 * component was rewritten around:
 *
 * - **TV** is a sticky *summary* strip, so it takes the VISIBLE span —
 *   `visibleStartMs`/`visibleEndMs`, the entry's window intersected with the
 *   scroll viewport by the caller (`PlaylistTimeline.tsx`). Zooming and panning
 *   walk the strip through the footage rather than re-sampling the same ten
 *   days. `viewportPx` is the scroll viewport's width, which is how much room
 *   the strip has to lay tiles out in. It renders nothing when the intersection
 *   is empty.
 * - **Radio** is a *time-positioned overlay* that has to stay aligned with the
 *   footage beneath it, so it ignores the visible span entirely: it fetches on
 *   the entry's own committed window (`entryStartMs`/`entryEndMs`) and lays its
 *   slots out as fractions of `bounds`, the same space `.playlistTimelineBar`
 *   is positioned in. The lane is `position: relative` and spans the whole
 *   zoomed track, so a percentage on an absolutely-positioned child is already
 *   track-relative — measuring against the viewport instead put a 12:05
 *   recording a day and a half into a ten-day track at high zoom.
 *
 * `flights` renders nothing here.
 */
export function LanePreview({
	group,
	channel,
	visibleStartMs,
	visibleEndMs,
	viewportPx,
	entryStartMs,
	entryEndMs,
	bounds,
}: {
	group: "tv" | "radio" | "flights";
	channel: string;
	visibleStartMs: number;
	visibleEndMs: number;
	viewportPx: number;
	entryStartMs: number;
	entryEndMs: number;
	bounds: TimelineBounds;
}) {
	if (group === "radio") {
		return (
			<RadioLanePreview
				station={channel}
				startMs={entryStartMs}
				endMs={entryEndMs}
				bounds={bounds}
			/>
		);
	}
	if (group !== "tv") return null;

	const buckets = thumbnailBuckets({
		startMs: visibleStartMs,
		endMs: visibleEndMs,
		viewportPx,
	});
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
 * assembled from whatever aired in it, each drawn at its own time position.
 *
 * Each slot is positioned against the TIMELINE BOUNDS, not against the entry's
 * window or the viewport, because that is the space its containing block is
 * laid out in. A recording that starts before the window and runs into it draws
 * at its true extent rather than being clipped to the window — the envelope
 * maps to the whole recording, so trimming the box would misalign the drawing
 * from the audio it depicts. `.playlistTimelinePreviewRadio` clips at the track
 * edge instead.
 */
function RadioLanePreview({
	station,
	startMs,
	endMs,
	bounds,
}: {
	station: string;
	startMs: number;
	endMs: number;
	bounds: TimelineBounds;
}) {
	const spans = usePeaksForSpan(station, startMs, endMs);
	// Nothing aired, or compute-peaks has not reached these recordings yet:
	// show nothing rather than an empty box, so a missing preview stays quiet.
	if (spans.length === 0) return null;
	return (
		<div className="playlistTimelinePreview playlistTimelinePreviewRadio">
			{spans.map((s) => {
				const leftFrac = msToFraction(s.startMs, bounds);
				const rightFrac = msToFraction(s.endMs, bounds);
				return (
					<div
						key={s.startMs}
						className="playlistTimelineWaveformSlot"
						style={{
							left: `${leftFrac * 100}%`,
							width: `${(rightFrac - leftFrac) * 100}%`,
						}}
					>
						<PeaksWaveform peaks={s.peaks} height={WAVEFORM_HEIGHT} />
					</div>
				);
			})}
		</div>
	);
}
