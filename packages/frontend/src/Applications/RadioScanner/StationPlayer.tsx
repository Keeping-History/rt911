import type React from "react";
import { useEffect, useRef, useState } from "react";
import { vttUrl } from "../../Providers/MediaStream/MediaStreamContext";
import {
	activeSegments,
	calcSeekSeconds,
	primarySegment,
	type Station,
} from "./stationGrouping";
import { WaveformVisualizer } from "./WaveformVisualizer";

interface StationPlayerProps {
	station: Station;
	nowMs: number;
	getNowMs: () => number;
	stationMuted: boolean;
	mutedItems: number[];
	clockPaused: boolean;
	showWaveform: boolean;
	captionsOn?: boolean;
}

/**
 * Plays one station as a continuous, clock-synced playlist: an <audio> per
 * in-window segment (start ≤ now < effectiveEnd). Sequential segments yield one
 * audible at a time; overlapping segments play concurrently and mix. The
 * waveform attaches to the primary (latest-starting) in-window segment.
 */
export const StationPlayer: React.FC<StationPlayerProps> = ({
	station,
	nowMs,
	getNowMs,
	stationMuted,
	mutedItems,
	clockPaused,
	showWaveform,
	captionsOn,
}) => {
	const segments = activeSegments(station, nowMs);
	const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());
	// Per-segment version counter — bumped in onLoadedMetadata so the waveform
	// remounts once its element is actually ready (not before).
	const [readyVersions, setReadyVersions] = useState<Map<number, number>>(new Map());

	const stationMutedRef = useRef(stationMuted);
	stationMutedRef.current = stationMuted;
	const mutedItemsRef = useRef(mutedItems);
	mutedItemsRef.current = mutedItems;
	const clockPausedRef = useRef(clockPaused);
	clockPausedRef.current = clockPaused;
	const getNowMsRef = useRef(getNowMs);
	getNowMsRef.current = getNowMs;

	// Health check: keep each mounted element playing and within 30s of expected.
	useEffect(() => {
		const id = setInterval(() => {
			if (clockPausedRef.current) return;
			const now = getNowMsRef.current();
			for (const [segId, el] of audioRefs.current) {
				const item = station.items.find((i) => i.id === segId);
				if (!item) continue;
				if (el.paused || el.ended) el.play().catch(() => {});
				const expected = calcSeekSeconds(item, now);
				if (Math.abs(el.currentTime - expected) > 30) el.currentTime = expected;
			}
		}, 15_000);
		return () => clearInterval(id);
	}, [station]);

	// Apply mute volume immediately: a file is silenced if its station is muted
	// or the file itself is muted.
	useEffect(() => {
		for (const [id, el] of audioRefs.current) {
			el.volume = stationMuted || mutedItems.includes(id) ? 0 : 1;
		}
	}, [stationMuted, mutedItems]);

	// Pause/resume all mounted elements when the clock pauses/resumes.
	useEffect(() => {
		for (const [, el] of audioRefs.current) {
			if (clockPaused) el.pause();
			else el.play().catch(() => {});
		}
	}, [clockPaused]);

	// Reseek on a clock scrub (a large jump), not on natural per-second advance.
	const prevNowRef = useRef(nowMs);
	useEffect(() => {
		const delta = nowMs - prevNowRef.current;
		prevNowRef.current = nowMs;
		if (Math.abs(delta) > 5_000) {
			for (const [segId, el] of audioRefs.current) {
				const item = station.items.find((i) => i.id === segId);
				if (item) el.currentTime = calcSeekSeconds(item, nowMs);
			}
		}
	}, [nowMs, station]);

	// Stable per-segment ref callbacks: a fixed identity means React invokes the
	// callback only on real mount/unmount, so a playing element is never re-muted
	// by an ordinary re-render (onCanPlay unmutes; we must not clobber that).
	const refCallbacks = useRef<Map<number, (el: HTMLAudioElement | null) => void>>(new Map());
	const audioRef = (id: number) => {
		let cb = refCallbacks.current.get(id);
		if (!cb) {
			cb = (el: HTMLAudioElement | null) => {
				if (el) {
					// Start muted so the browser permits autoplay; onCanPlay switches
					// to volume-based control after play() resolves.
					el.muted = true;
					audioRefs.current.set(id, el);
				} else {
					// Explicitly pause before losing the reference — removing an
					// <audio> element from the DOM does not stop browser playback.
					audioRefs.current.get(id)?.pause();
					audioRefs.current.delete(id);
				}
			};
			refCallbacks.current.set(id, cb);
		}
		return cb;
	};

	const primary = primarySegment(segments);

	return (
		<>
			{segments.map((item) => (
				<audio
					key={item.id}
					ref={audioRef(item.id)}
					src={item.url}
					crossOrigin="anonymous"
					style={{ display: "none" }}
					onLoadedMetadata={(e) => {
						e.currentTarget.currentTime = calcSeekSeconds(item, getNowMsRef.current());
						setReadyVersions((prev) => {
							const next = new Map(prev);
							next.set(item.id, (prev.get(item.id) ?? 0) + 1);
							return next;
						});
					}}
					onCanPlay={(e) => {
						const el = e.currentTarget;
						if (clockPausedRef.current) return;
						el.play()
							.then(() => {
								el.muted = false;
								el.volume =
									stationMutedRef.current || mutedItemsRef.current.includes(item.id)
										? 0
										: 1;
							})
							.catch(() => {});
					}}
				>
					{captionsOn && vttUrl(item.subtitles) && (
						<track
							kind="subtitles"
							srcLang="en"
							label="English"
							src={vttUrl(item.subtitles)}
						/>
					)}
				</audio>
			))}
			{showWaveform && primary && (
				<WaveformVisualizer
					key={`wf-${station.key}-${primary.id}-${readyVersions.get(primary.id) ?? 0}`}
					audioEl={audioRefs.current.get(primary.id) ?? null}
				/>
			)}
		</>
	);
};
