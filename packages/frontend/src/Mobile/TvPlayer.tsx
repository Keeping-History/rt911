// packages/frontend/src/Mobile/TvPlayer.tsx
// The shell-level TV player: IpodShell mounts this OUTSIDE the screen stack
// (next to StationPlayer, and for the same reason) so backing out with MENU
// only hides the picture — the <video> element never unmounts, and the audio
// keeps playing. The shell keys this component by item id, so switching
// channels is a clean remount with a fresh start position.
import { QuickTimeVideoEmbed } from "classicy";
import { useEffect, useRef } from "react";
import {
	type HlsAbrApi,
	maybeProbeUp,
	TV_ABR_CONFIG,
} from "../Applications/TV/abr";
import { calcSeekSeconds } from "../Applications/TV/clockDrift";
import type { MediaItem } from "../Providers/MediaStream/MediaStreamContext";

// Mobile ABR ceiling: mid tier (level 1 of the thumb/mid/full ladder). On an
// iPod-sized screen the full 2.6M rendition is visually indistinguishable but
// burns ~6× the data; ABR still degrades to thumb on poor connections.
export const MOBILE_TV_LEVEL = 1;

/** Re-seek when the picture drifts this far from the virtual clock (desktop TV
 *  uses the same threshold). */
const DRIFT_TOLERANCE_S = 30;
/** Health-check cadence, matching the desktop TV app. */
const HEALTH_CHECK_MS = 15_000;
/** nowMs ticks once a second; a bigger delta means a Time Travel jump. */
const CLOCK_JUMP_MS = 5_000;

interface TvPlayerProps {
	item: MediaItem;
	/** False hides the picture (CSS) — playback, and so audio, continue. */
	visible: boolean;
	nowMs: number;
	getNowMs: () => number;
	clockPaused: boolean;
}

/** The <hls-video> element classicy renders exposes hls.js as `.api`
 *  (absent on Safari's native-HLS path — every access is optional). */
type HlsVideoEl = HTMLVideoElement & { api?: HlsAbrApi };

export function TvPlayer({
	item,
	visible,
	nowMs,
	getNowMs,
	clockPaused,
}: TvPlayerProps) {
	const videoRef = useRef<HlsVideoEl | null>(null);
	// Refs so the health-check interval (registered once) reads fresh values.
	const itemRef = useRef(item);
	itemRef.current = item;
	const clockPausedRef = useRef(clockPaused);
	clockPausedRef.current = clockPaused;

	// hls config is built exactly once per mount (the shell keys us by item.id):
	// initial position and quality tier at first sight. Later corrections seek
	// the media element directly — a changing config would remount the player.
	const hlsOptionsRef = useRef<object | null>(null);
	if (hlsOptionsRef.current === null) {
		hlsOptionsRef.current = {
			hls: {
				...TV_ABR_CONFIG,
				startLevel: MOBILE_TV_LEVEL,
				startPosition: calcSeekSeconds(item, getNowMs()),
			},
		};
	}

	// Health check: resume a stalled element, correct drift, and probe the ABR
	// upward when it parks below the ceiling on a stale bandwidth estimate.
	useEffect(() => {
		const id = setInterval(() => {
			const el = videoRef.current;
			if (!el || clockPausedRef.current) return;
			if (el.paused || el.ended) el.play().catch(() => {});
			const expected = calcSeekSeconds(itemRef.current, getNowMs());
			if (Math.abs(el.currentTime - expected) > DRIFT_TOLERANCE_S) {
				el.currentTime = expected;
			}
			maybeProbeUp(el, el.api, MOBILE_TV_LEVEL);
		}, HEALTH_CHECK_MS);
		return () => clearInterval(id);
	}, [getNowMs]);

	// Immediate re-seek on Time Travel jumps: nowMs normally advances ~1 s per
	// tick, so a larger delta means the user seeked — waiting for the health
	// check would leave the picture up to 15 s on the wrong time.
	const prevNowMsRef = useRef(nowMs);
	useEffect(() => {
		const delta = Math.abs(nowMs - prevNowMsRef.current);
		prevNowMsRef.current = nowMs;
		if (delta <= CLOCK_JUMP_MS) return;
		const el = videoRef.current;
		if (el) el.currentTime = calcSeekSeconds(itemRef.current, getNowMs());
	}, [nowMs, getNowMs]);

	// On pause, pin the freeze frame to the exact clock position (the playing
	// prop below handles the actual pause/resume).
	useEffect(() => {
		if (!clockPaused) return;
		const el = videoRef.current;
		if (el) el.currentTime = calcSeekSeconds(itemRef.current, getNowMs());
	}, [clockPaused, getNowMs]);

	return (
		<div className={`ipodTvPlayer${visible ? "" : " ipodTvPlayerHidden"}`}>
			<QuickTimeVideoEmbed
				appId="IpodShell.mobile"
				name={item.source ?? String(item.id)}
				url={item.url}
				type="video"
				hideControls
				onMediaElement={(el: HTMLVideoElement | null) => {
					videoRef.current = el as HlsVideoEl | null;
				}}
				onReady={() => {
					const el = videoRef.current;
					if (!el) return;
					el.currentTime = calcSeekSeconds(itemRef.current, getNowMs());
					if (el.api && el.api.autoLevelCapping !== MOBILE_TV_LEVEL) {
						el.api.autoLevelCapping = MOBILE_TV_LEVEL;
					}
				}}
				playing={!clockPaused}
				muted={false}
				volume={1}
				options={hlsOptionsRef.current}
				crossOrigin="anonymous"
				playsInline
			/>
		</div>
	);
}
