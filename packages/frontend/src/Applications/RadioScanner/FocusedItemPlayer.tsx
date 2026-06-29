import { ClassicyButton } from "classicy";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import styles from "./RadioScanner.module.scss";

interface FocusedItemPlayerProps {
	item: MediaItem;
	onDismiss: () => void;
}

export const FocusedItemPlayer: React.FC<FocusedItemPlayerProps> = ({ item, onDismiss }) => {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [playing, setPlaying] = useState(false);

	useEffect(() => {
		const el = audioRef.current;
		if (!el) return;
		el.play()
			.then(() => setPlaying(true))
			.catch(() => {});
	}, []);

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

	return (
		<div className={styles.rsFocusedPlayer}>
			<div className={styles.rsFocusedHeader}>
				<p className={styles.rsFocusedLabel}>Playing</p>
				<p className={styles.rsFocusedTitle}>{item.full_title || item.title}</p>
			</div>
			{/* biome-ignore lint/a11y/useMediaCaptions: historical playback, no transcript */}
			<audio ref={audioRef} src={item.url} crossOrigin="anonymous" style={{ display: "none" }} />
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
