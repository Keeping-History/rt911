import type { HyperCardPartProps } from "classicy";
import { QuickTimeVideoEmbed, timeFriendly } from "classicy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { vttUrl } from "../../../Providers/MediaStream/MediaStreamContext";
import {
	type DirectusVideoItem,
	fetchDirectusVideoItem,
} from "./directusCollections";
import { type DirectusVideoOptions, readVideoOptions } from "./videoOptions";
import { resolveSegment, toUtcMs } from "./videoSegment";
import "./DirectusVideoPart.css";

/**
 * `directusVideo` HyperCard part — embeds one TV channel stream from the
 * `tv_channels` Directus collection, optionally limited to a start/end segment.
 *
 * Authored in a stack's JSON:
 *
 *   { "id": "tv", "type": "directusVideo", "rect": [16, 40, 388, 220],
 *     "options": { "channelId": 3, "start": 120, "end": 240,
 *                  "controls": true, "loop": true, "captions": true } }
 *
 * `channelId` picks the `tv_channels` row (or pass a direct HLS `url`).
 * `start`/`end` bound the playback window — a number/"M:SS" is a stream offset,
 * a date-bearing time (e.g. "2001-09-11T12:46:00") is a wall-clock instant
 * mapped via the channel's `start_date` (see videoSegment.ts).
 */

type SourceState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; url: string; title?: string; subtitlesUrl?: string; channelStartMs: number | null }
	| { status: "error"; message: string };

/** Resolve an embed's source: a direct `url`, or a fetched `tv_channels` row. */
function useDirectusVideoSource(opts: DirectusVideoOptions): SourceState {
	const { url, channelId, title } = opts;
	const [state, setState] = useState<SourceState>({ status: "idle" });

	useEffect(() => {
		if (url) {
			setState({ status: "ready", url, title, subtitlesUrl: undefined, channelStartMs: null });
			return;
		}
		if (channelId === undefined || channelId === "") {
			setState({ status: "idle" });
			return;
		}
		const controller = new AbortController();
		setState({ status: "loading" });
		fetchDirectusVideoItem(channelId, fetch, controller.signal)
			.then((item: DirectusVideoItem) =>
				setState({
					status: "ready",
					url: item.url,
					title: title ?? item.full_title ?? item.title,
					subtitlesUrl: vttUrl(item.subtitles ?? undefined),
					channelStartMs: toUtcMs(item.start_date ?? ""),
				}),
			)
			.catch((err: unknown) => {
				if (controller.signal.aborted) return;
				setState({
					status: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => controller.abort();
	}, [url, channelId, title]);

	return state;
}

export interface DirectusVideoProps extends DirectusVideoOptions {
	/** Unique id for the underlying player instance. */
	appId: string;
	/** Fired once when a non-looping segment reaches its end bound. */
	onSegmentEnd?: () => void;
	/** Multiview mutes every tile but the active one; a tap solos a tile. */
	forceMuted?: boolean;
	onActivate?: () => void;
}

/**
 * The reusable video body: source resolution, the classicy HLS player, and
 * start/end segment enforcement (seek to start, clamp/loop/stop at end). Used
 * directly by the single-video part and by each multiview tile.
 */
export function DirectusVideo(props: DirectusVideoProps) {
	const { appId, onSegmentEnd, forceMuted, onActivate, ...opts } = props;
	const source = useDirectusVideoSource(opts);

	const channelStartMs = source.status === "ready" ? source.channelStartMs : null;
	const { startSec, endSec } = useMemo(
		() => resolveSegment(opts.start, opts.end, channelStartMs),
		[opts.start, opts.end, channelStartMs],
	);

	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
	const [currentSec, setCurrentSec] = useState(startSec);
	const endedRef = useRef(false);

	// Enforce the [startSec, endSec] window on the raw media element.
	useEffect(() => {
		if (!videoEl) return;
		endedRef.current = false;

		const seekToStart = () => {
			if (startSec > 0) videoEl.currentTime = startSec;
		};
		const onTime = () => {
			setCurrentSec(videoEl.currentTime);
			if (videoEl.currentTime < startSec - 0.5) {
				videoEl.currentTime = startSec;
				return;
			}
			if (endSec !== undefined && videoEl.currentTime >= endSec) {
				if (opts.loop) {
					videoEl.currentTime = startSec;
					void videoEl.play().catch(() => {});
				} else if (!endedRef.current) {
					endedRef.current = true;
					videoEl.pause();
					onSegmentEnd?.();
				}
			}
		};
		if (videoEl.readyState >= 1) seekToStart();
		videoEl.addEventListener("loadedmetadata", seekToStart);
		videoEl.addEventListener("timeupdate", onTime);
		return () => {
			videoEl.removeEventListener("loadedmetadata", seekToStart);
			videoEl.removeEventListener("timeupdate", onTime);
		};
	}, [videoEl, startSec, endSec, opts.loop, onSegmentEnd]);

	// Poster is a plain <video> attribute the embed doesn't expose.
	useEffect(() => {
		if (videoEl && opts.poster) videoEl.poster = opts.poster;
	}, [videoEl, opts.poster]);

	// Captions default on/off; the CC control flips this at runtime.
	const [captionsEnabled, setCaptionsEnabled] = useState(!!opts.captions);
	useEffect(() => setCaptionsEnabled(!!opts.captions), [opts.captions]);

	if (source.status === "error") {
		return (
			<div className="classicyHyperCardDirectusVideo classicyHyperCardDirectusVideoMessage" role="alert">
				Could not load video — {source.message}
			</div>
		);
	}
	if (source.status === "loading") {
		return <div className="classicyHyperCardDirectusVideo classicyHyperCardDirectusVideoMessage">Loading video…</div>;
	}
	if (source.status !== "ready") {
		return <div className="classicyHyperCardDirectusVideo classicyHyperCardDirectusVideoMessage">No video source</div>;
	}

	const controls = opts.controls !== false;
	const muted = forceMuted ?? opts.muted ?? (opts.autoPlay ? true : false);

	return (
		<div
			className="classicyHyperCardDirectusVideo"
			onClick={onActivate}
			role={onActivate ? "button" : undefined}
			tabIndex={onActivate ? 0 : undefined}
			onKeyDown={
				onActivate
					? (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onActivate();
							}
						}
					: undefined
			}
		>
			<QuickTimeVideoEmbed
				appId={appId}
				name={source.title ?? "TV Channel"}
				url={source.url}
				type="video"
				subtitlesUrl={source.subtitlesUrl}
				autoPlay={opts.autoPlay}
				hideControls={!controls}
				muted={muted}
				volume={opts.volume}
				captionsEnabled={captionsEnabled}
				onCaptionsEnabledChange={setCaptionsEnabled}
				onMediaElement={setVideoEl}
				playsInline
			/>
			{opts.overlay && (
				<div className="classicyHyperCardDirectusVideoBug" aria-hidden="true">
					{source.title && <span className="classicyHyperCardDirectusVideoBugName">{source.title}</span>}
					<span className="classicyHyperCardDirectusVideoBugTime">{timeFriendly(currentSec)}</span>
				</div>
			)}
		</div>
	);
}

/** The registered HyperCard part: adapts part props to {@link DirectusVideo}. */
export const DirectusVideoPart = ({ options, partId, stackId, fire }: HyperCardPartProps) => {
	const opts = useMemo(() => readVideoOptions(options), [options]);
	// Non-looping segment end fires the part's own script (e.g. `go next`).
	const onSegmentEnd = useCallback(() => fire(), [fire]);
	return (
		<DirectusVideo
			{...opts}
			appId={`hc-${stackId}-${partId}`}
			onSegmentEnd={opts.loop ? undefined : onSegmentEnd}
		/>
	);
};
