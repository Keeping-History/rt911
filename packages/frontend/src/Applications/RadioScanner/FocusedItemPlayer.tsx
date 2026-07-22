import { ClassicyButton } from "classicy";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
	type MediaItem,
	vttUrl,
} from "../../Providers/MediaStream/MediaStreamContext";
import { CaptionOverlay } from "./CaptionOverlay";
import {
	type CaptionStyle,
	DEFAULT_CAPTION_STYLE,
	type VizMode,
} from "./radioScannerSettings";
import styles from "./RadioScanner.module.scss";
import { WaveformVisualizer } from "./WaveformVisualizer";
import { RadioProgressBar } from "./RadioProgressBar";
import { setAudioLevel } from "./audioCapture";

interface FocusedItemPlayerProps {
	item: MediaItem;
	onDismiss: () => void;
	showWaveform: boolean;
	captionsOn?: boolean;
	captionStyle?: CaptionStyle;
	vizMode: VizMode;
	onCycleVizMode: () => void;
	waveColors: { bright: string; dim: string } | null;
	maxVolume: number;
}

export const FocusedItemPlayer: React.FC<FocusedItemPlayerProps> = ({
	item,
	onDismiss,
	showWaveform,
	captionsOn,
	captionStyle = DEFAULT_CAPTION_STYLE,
	vizMode,
	onCycleVizMode,
	waveColors,
	maxVolume,
}) => {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [playing, setPlaying] = useState(false);
	// Bumped in onLoadedMetadata so the waveform remounts once the element is
	// actually ready — mirrors StationPlayer's readyVersions handling.
	const [readyVersion, setReadyVersion] = useState(0);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);

	useEffect(() => {
		const el = audioRef.current;
		if (!el) return;
		el.play()
			.then(() => setPlaying(true))
			.catch(() => {});
	}, []);

	// Volume ceiling. This element is captured by the waveform whenever it is
	// shown, and Safari ignores el.volume on captured elements — mirror the
	// level into the in-graph gain as well.
	useEffect(() => {
		const el = audioRef.current;
		if (!el) return;
		el.volume = maxVolume;
		setAudioLevel(el, maxVolume);
	}, [maxVolume]);

	const togglePlay = () => {
		const el = audioRef.current;
		if (!el) return;
		if (playing) {
			el.pause();
			setPlaying(false);
		} else {
			el.play()
				.then(() => setPlaying(true))
				.catch(() => {});
		}
	};

	const seekToPct = (pct: number) => {
		const el = audioRef.current;
		if (!el) return;
		const seconds = pct * (el.duration || 0);
		el.currentTime = seconds;
		setCurrentTime(seconds);
	};

	return (
		<div className={styles.rsFocusedPlayer}>
			<div className={styles.rsFocusedHeader}>
				<p className={styles.rsFocusedLabel}>Playing</p>
				<p className={styles.rsFocusedTitle}>{item.full_title || item.title}</p>
			</div>
			{/* eslint-disable-next-line jsx-a11y/media-has-caption -- captions are rendered by the CaptionOverlay sibling, not a native <track> (audio has no display surface for one) */}
			<audio
				ref={audioRef}
				src={item.url}
				crossOrigin="anonymous"
				style={{ display: "none" }}
				onLoadedMetadata={() => {
					setReadyVersion((v) => v + 1);
					setDuration(audioRef.current?.duration ?? 0);
				}}
				onDurationChange={() => setDuration(audioRef.current?.duration ?? 0)}
				onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
				onEnded={() => setPlaying(false)}
			/>
			{captionsOn && (
				<CaptionOverlay
					audioEl={audioRef.current}
					subtitlesUrl={vttUrl(item.subtitles)}
					captionStyle={captionStyle}
				/>
			)}
			{showWaveform && (
				<WaveformVisualizer
					key={`wf-${item.id}-${readyVersion}`}
					audioEl={audioRef.current}
					mode={vizMode}
					onCycleMode={onCycleVizMode}
					colors={waveColors}
				/>
			)}
			<RadioProgressBar
				currentTime={currentTime}
				duration={duration}
				onSeekPct={seekToPct}
			/>
			<div className={styles.rsFocusedControls}>
				<ClassicyButton buttonSize="small" onClickFunc={togglePlay}>
					{playing ? "Pause" : "Play"}
				</ClassicyButton>
				<ClassicyButton buttonSize="small" onClickFunc={onDismiss}>
					← Back to Live
				</ClassicyButton>
			</div>
		</div>
	);
};
