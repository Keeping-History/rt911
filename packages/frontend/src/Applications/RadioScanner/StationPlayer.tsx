import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { vttUrl } from "../../Providers/MediaStream/MediaStreamContext";
import { clearAudioBlocked, markAudioBlocked } from "./audioBlocked";
import { setAudioSilenced } from "./audioCapture";
import type { VizMode } from "./radioScannerSettings";
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
	vizMode: VizMode;
	onCycleVizMode: () => void;
	waveColors: { bright: string; dim: string } | null;
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
	vizMode,
	onCycleVizMode,
	waveColors,
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

	// Elements whose play() has resolved at least once. Until then an element
	// must stay el.muted = true (that's what lets the browser permit autoplay),
	// so the mute effect below may only unmute unlocked elements.
	const unlockedRef = useRef<Set<number>>(new Set());

	// Called after a successful play(): the element is past the autoplay gate,
	// so muting can be driven through el.muted from here on. el.volume alone is
	// not enough — Safari ignores it once the visualizer's
	// createMediaElementSource captures the element (every clip is captured
	// while it's the newest), and iOS ignores it always.
	const unlockAndApplyMuteState = useCallback(
		(id: number, el: HTMLAudioElement) => {
			unlockedRef.current.add(id);
			const silenced =
				stationMutedRef.current || mutedItemsRef.current.includes(id);
			el.muted = silenced;
			el.volume = silenced ? 0 : 1;
			setAudioSilenced(el, silenced);
		},
		[],
	);

	// Every play() goes through here so the shared audioBlocked signal tracks
	// which elements the autoplay policy is holding back: a NotAllowedError
	// means a user gesture will fix it (the overlay tells the user to click);
	// any success clears the element's token.
	const tryPlay = useCallback(
		(id: number, el: HTMLAudioElement) => {
			el.play()
				.then(() => {
					clearAudioBlocked(`play-${id}`);
					unlockAndApplyMuteState(id, el);
				})
				.catch((err: unknown) => {
					if ((err as DOMException | null)?.name === "NotAllowedError") {
						markAudioBlocked(`play-${id}`);
					}
				});
		},
		[unlockAndApplyMuteState],
	);

	// Health check: keep each mounted element playing and within 30s of expected.
	useEffect(() => {
		const id = setInterval(() => {
			if (clockPausedRef.current) return;
			const now = getNowMsRef.current();
			for (const [segId, el] of audioRefs.current) {
				const item = station.items.find((i) => i.id === segId);
				if (!item) continue;
				if (el.paused || el.ended) {
					// A late unlock (initial autoplay was blocked; a user gesture has
					// since granted audio) must also clear the autoplay mute, or the
					// element resumes playing but stays silent forever.
					tryPlay(segId, el);
				}
				const expected = calcSeekSeconds(item, now);
				if (Math.abs(el.currentTime - expected) > 30) el.currentTime = expected;
			}
		}, 15_000);
		return () => clearInterval(id);
	}, [station, tryPlay]);

	// A user gesture is the first moment blocked playback can start: Safari
	// refuses gesture-less play() on page load, so a restored session autoplays
	// into a blocked state — and clicking the already-selected station changes
	// no React state, so without this nothing would retry until the health
	// check above. Any click or keypress retries immediately.
	useEffect(() => {
		const retryBlockedPlayback = () => {
			if (clockPausedRef.current) return;
			for (const [segId, el] of audioRefs.current) {
				if (el.paused || el.ended) {
					tryPlay(segId, el);
				}
			}
		};
		document.addEventListener("click", retryBlockedPlayback, true);
		document.addEventListener("keydown", retryBlockedPlayback, true);
		return () => {
			document.removeEventListener("click", retryBlockedPlayback, true);
			document.removeEventListener("keydown", retryBlockedPlayback, true);
		};
	}, [tryPlay]);

	// Apply mute state immediately: a file is silenced if its station is muted
	// or the file itself is muted. Muting is always safe, but unmuting via
	// el.muted is only allowed once the element's autoplay unlock happened.
	// Safari ignores volume AND muted on visualizer-captured elements, so the
	// state is mirrored into the capture module's in-graph gain too.
	useEffect(() => {
		for (const [id, el] of audioRefs.current) {
			const silenced = stationMuted || mutedItems.includes(id);
			el.volume = silenced ? 0 : 1;
			if (silenced) el.muted = true;
			else if (unlockedRef.current.has(id)) el.muted = false;
			setAudioSilenced(el, silenced);
		}
	}, [stationMuted, mutedItems]);

	// Pause/resume all mounted elements when the clock pauses/resumes.
	useEffect(() => {
		for (const [id, el] of audioRefs.current) {
			if (clockPaused) el.pause();
			else tryPlay(id, el);
		}
	}, [clockPaused, tryPlay]);

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
					// A remount of the same id gets a fresh element that must redo
					// the autoplay dance from its muted starting state.
					unlockedRef.current.delete(id);
					// A gone element no longer needs a gesture.
					clearAudioBlocked(`play-${id}`);
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
				// eslint-disable-next-line jsx-a11y/media-has-caption -- live radio stream segments; no caption track is available
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
						tryPlay(item.id, el);
					}}
					onPause={(e) => {
						const el = e.currentTarget;
						// A pause we didn't initiate is the autoplay policy speaking —
						// Safari lets muted play() RESOLVE, then punishes the gesture-less
						// unmute with a silent pause (no rejection anywhere). Our own
						// pauses are excluded: clock pause (guarded), natural end
						// (el.ended), unmount teardown (element already out of audioRefs
						// when the queued event fires).
						if (clockPausedRef.current || el.ended) return;
						if (!audioRefs.current.has(item.id)) return;
						markAudioBlocked(`play-${item.id}`);
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
					mode={vizMode}
					onCycleMode={onCycleVizMode}
					colors={waveColors}
				/>
			)}
		</>
	);
};
