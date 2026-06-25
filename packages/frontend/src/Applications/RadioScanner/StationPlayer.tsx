import type React from "react";
import { useEffect, useRef, useState } from "react";
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
	muted: boolean;
	clockPaused: boolean;
	showWaveform: boolean;
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
	muted,
	clockPaused,
	showWaveform,
}) => {
	const segments = activeSegments(station, nowMs);
	const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());
	// Per-segment version counter — bumped in onLoadedMetadata so the waveform
	// remounts once its element is actually ready (not before).
	const [readyVersions, setReadyVersions] = useState<Map<number, number>>(new Map());

	const mutedRef = useRef(muted);
	mutedRef.current = muted;
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

	// Apply mute volume immediately to all mounted elements.
	useEffect(() => {
		for (const [, el] of audioRefs.current) el.volume = muted ? 0 : 1;
	}, [muted]);

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

	const primary = primarySegment(segments);

	return (
		<>
			{segments.map((item) => (
				<audio
					key={item.id}
					ref={(el) => {
						if (el) {
							// Start muted so the browser permits autoplay; onCanPlay
							// switches to volume control after play() resolves.
							el.muted = true;
							audioRefs.current.set(item.id, el);
						} else {
							audioRefs.current.delete(item.id);
						}
					}}
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
								el.volume = mutedRef.current ? 0 : 1;
							})
							.catch(() => {});
					}}
				/>
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
