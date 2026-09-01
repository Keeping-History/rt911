import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type MediaItem,
	vttUrl,
} from "../../Providers/MediaStream/MediaStreamContext";
import { clearAudioBlocked, markAudioBlocked } from "./audioBlocked";
import { setAudioLevel } from "./audioCapture";
import { CaptionOverlay } from "./CaptionOverlay";
import {
	type CaptionStyle,
	DEFAULT_CAPTION_STYLE,
	type VizMode,
} from "./radioScannerSettings";
import { resolveAudioUrl } from "./audioSource";
import {
	type PendingSeek,
	seekLanded,
	withStartFragment,
} from "./segmentSeek";
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
	captionStyle?: CaptionStyle;
	vizMode: VizMode;
	onCycleVizMode: () => void;
	waveColors: { bright: string; dim: string } | null;
	maxVolume: number;
	/** true = play the source recording rather than the enhanced render. */
	playOriginalAudio?: boolean;
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
	captionStyle = DEFAULT_CAPTION_STYLE,
	vizMode,
	onCycleVizMode,
	waveColors,
	maxVolume,
	playOriginalAudio = false,
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
	const maxVolumeRef = useRef(maxVolume);
	maxVolumeRef.current = maxVolume;
	const clockPausedRef = useRef(clockPaused);
	clockPausedRef.current = clockPaused;
	const getNowMsRef = useRef(getNowMs);
	getNowMsRef.current = getNowMs;
	const stationRef = useRef(station);
	stationRef.current = station;
	const playOriginalAudioRef = useRef(playOriginalAudio);
	playOriginalAudioRef.current = playOriginalAudio;

	// Per-segment src, frozen at mount WITH a #t= start-position fragment:
	// Safari resolves media fragments natively with a ranged fetch, so an
	// element begins at its clock position without needing a post-load seek —
	// the operation iOS clamps on long progressive files (see segmentSeek.ts).
	// Recomputed from scratch when the original/enhanced toggle changes.
	const initialSrcRef = useRef<Map<number, string>>(new Map());
	const srcModeRef = useRef(playOriginalAudio);
	if (srcModeRef.current !== playOriginalAudio) {
		srcModeRef.current = playOriginalAudio;
		initialSrcRef.current.clear();
	}
	const srcFor = (item: MediaItem): string => {
		let src = initialSrcRef.current.get(item.id);
		if (src === undefined) {
			src = withStartFragment(
				resolveAudioUrl(item, playOriginalAudio),
				calcSeekSeconds(item, getNowMsRef.current()),
			);
			initialSrcRef.current.set(item.id, src);
		}
		return src;
	};

	// Every programmatic seek goes through here so it can be VERIFIED: iOS
	// Safari clamps currentTime writes whose target isn't buffered yet (desktop
	// browsers queue them), which left mobile audio ignoring clock jumps
	// entirely. The element's `seeked` event checks where the seek landed; a
	// clamp triggers one fragment-reload fallback per intent (see verifySeek).
	const pendingSeekRef = useRef<Map<number, PendingSeek>>(new Map());
	const seekSegmentTo = useCallback(
		(item: MediaItem, el: HTMLAudioElement, want: number) => {
			pendingSeekRef.current.set(item.id, {
				want,
				atMs: Date.now(),
				retried: false,
			});
			el.currentTime = want;
		},
		[],
	);

	const verifySeek = useCallback((item: MediaItem, el: HTMLAudioElement) => {
		const pending = pendingSeekRef.current.get(item.id);
		if (!pending) return;
		if (seekLanded(el.currentTime, pending, Date.now(), clockPausedRef.current)) {
			pendingSeekRef.current.delete(item.id);
			return;
		}
		if (pending.retried) {
			// The fallback also missed — stop here; the health check re-issues a
			// fresh intent within 15s while the drift persists.
			pendingSeekRef.current.delete(item.id);
			return;
		}
		// Clamped: reposition by reloading at a fresh #t= fragment, which Safari
		// honors with a ranged fetch at the target. Keep React's rendered src in
		// agreement so the next render doesn't undo it. onCanPlay restarts
		// playback through the usual autoplay dance.
		const target = calcSeekSeconds(item, getNowMsRef.current());
		const src = withStartFragment(
			resolveAudioUrl(item, playOriginalAudioRef.current),
			target,
		);
		pendingSeekRef.current.set(item.id, {
			want: target,
			atMs: Date.now(),
			retried: true,
		});
		initialSrcRef.current.set(item.id, src);
		el.src = src;
		el.load();
	}, []);

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
			const level = silenced ? 0 : maxVolumeRef.current;
			el.muted = silenced;
			el.volume = level;
			setAudioLevel(el, level);
		},
		[],
	);

	// Every play() goes through here so the shared audioBlocked signal tracks
	// which elements the autoplay policy is holding back: a NotAllowedError
	// means a user gesture will fix it (the overlay tells the user to click);
	// any success clears the element's token.
	const tryPlay = useCallback(
		(id: number, el: HTMLAudioElement) => {
			// Re-anchor to the virtual clock before starting. A blocked element
			// resumes from the currentTime it had when its metadata loaded, but the
			// clock kept running while it sat paused — and Safari refuses every
			// gesture-less play() after a page load, so on mobile a fresh page
			// always sits blocked until the first tap. That gap used to persist as
			// audible desync: the health check only corrects drift beyond 30s, so
			// anything smaller stuck until the next clock scrub re-seeked it
			// ("starts at the wrong point until you change the time"). The 2s
			// tolerance leaves healthy starts (canplay right after loadedmetadata,
			// clock-pause resumes, where the clock was frozen too) alone.
			const item = stationRef.current.items.find((i) => i.id === id);
			if (item) {
				const expected = calcSeekSeconds(item, getNowMsRef.current());
				if (Math.abs(el.currentTime - expected) > 2) {
					seekSegmentTo(item, el, expected);
				}
			}
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
		[unlockAndApplyMuteState, seekSegmentTo],
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
				if (Math.abs(el.currentTime - expected) > 30) {
					seekSegmentTo(item, el, expected);
				}
			}
		}, 15_000);
		return () => clearInterval(id);
	}, [station, tryPlay, seekSegmentTo]);

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
		document.addEventListener("pointerdown", retryBlockedPlayback, true);
		return () => {
			document.removeEventListener("click", retryBlockedPlayback, true);
			document.removeEventListener("keydown", retryBlockedPlayback, true);
			document.removeEventListener("pointerdown", retryBlockedPlayback, true);
		};
	}, [tryPlay]);

	// Apply mute state and the volume ceiling immediately: a file is silenced
	// if its station is muted or the file itself is muted; otherwise it plays
	// at the user's max-volume setting. Muting is always safe, but unmuting via
	// el.muted is only allowed once the element's autoplay unlock happened.
	// Safari ignores volume AND muted on visualizer-captured elements, so the
	// level is mirrored into the capture module's in-graph gain too.
	useEffect(() => {
		for (const [id, el] of audioRefs.current) {
			const silenced = stationMuted || mutedItems.includes(id);
			const level = silenced ? 0 : maxVolume;
			el.volume = level;
			if (silenced) el.muted = true;
			else if (unlockedRef.current.has(id)) el.muted = false;
			setAudioLevel(el, level);
		}
	}, [stationMuted, mutedItems, maxVolume]);

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
				if (item) seekSegmentTo(item, el, calcSeekSeconds(item, nowMs));
			}
		}
	}, [nowMs, station, seekSegmentTo]);

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
					initialSrcRef.current.delete(id);
					pendingSeekRef.current.delete(id);
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
					src={srcFor(item)}
					crossOrigin="anonymous"
					style={{ display: "none" }}
					onLoadedMetadata={(e) => {
						// The #t= fragment already positioned the element near its clock
						// spot; this nudge covers the load time and non-fragment browsers.
						seekSegmentTo(item, e.currentTarget, calcSeekSeconds(item, getNowMsRef.current()));
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
					onSeeked={(e) => verifySeek(item, e.currentTarget)}
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
				/>
			))}
			{captionsOn && primary && (
				<CaptionOverlay
					audioEl={audioRefs.current.get(primary.id) ?? null}
					subtitlesUrl={vttUrl(primary.subtitles)}
					captionStyle={captionStyle}
				/>
			)}
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
