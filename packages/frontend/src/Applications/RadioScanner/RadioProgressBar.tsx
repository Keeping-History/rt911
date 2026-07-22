import { timeFriendly } from "classicy";
import type React from "react";
import styles from "./RadioScanner.module.scss";

interface RadioProgressBarProps {
	currentTime: number;
	duration: number;
	onSeekPct: (pct: number) => void;
}

/**
 * Seekable progress/duration slider for the RadioScanner focused player.
 * Pure and props-only: the owning FocusedItemPlayer feeds it the audio
 * element's currentTime/duration and turns onSeekPct back into a seek.
 */
export const RadioProgressBar: React.FC<RadioProgressBarProps> = ({
	currentTime,
	duration,
	onSeekPct,
}) => (
	<div className={styles.rsFocusedProgress}>
		<input
			type="range"
			className={styles.rsFocusedProgressBar}
			min={0}
			max={1}
			step={0.001}
			value={duration > 0 ? currentTime / duration : 0}
			aria-label="Seek"
			aria-valuetext={`${timeFriendly(currentTime)} of ${timeFriendly(duration)}`}
			onChange={(e) => onSeekPct(Number.parseFloat(e.target.value))}
		/>
		<p className={styles.rsFocusedTime}>
			{timeFriendly(currentTime)} / {timeFriendly(duration)}
		</p>
	</div>
);
