import type React from "react";
import { useQuickTimeSubtitles } from "classicy";
import { useEffect, useState } from "react";
import styles from "./RadioScanner.module.scss";
import { type CaptionStyle, captionTextStyle } from "./radioScannerSettings";

interface CaptionOverlayProps {
	/** The playing <audio> whose currentTime drives cue selection, or null until ready. */
	audioEl: HTMLAudioElement | null;
	/** Public .vtt URL for the segment; captions are hidden when absent. */
	subtitlesUrl?: string;
	/** User-configured caption appearance (font, colors, opacity, size). */
	captionStyle: CaptionStyle;
}

/**
 * Draws the active subtitle cue for a playing <audio> element as a caption band
 * over the player. The TV app gets this for free — classicy's video embed paints
 * ::cue over the <video> surface — but <audio> has no rendering surface, so we
 * reuse classicy's parser (useQuickTimeSubtitles) for the active-cue lookup and
 * render the text ourselves, keyed off the element's playback position.
 */
export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
	audioEl,
	subtitlesUrl,
	captionStyle,
}) => {
	const { activeCueText } = useQuickTimeSubtitles(subtitlesUrl);
	const [text, setText] = useState<string | null>(null);

	useEffect(() => {
		if (!audioEl || !subtitlesUrl) {
			setText(null);
			return;
		}
		// timeupdate fires ~4x/sec during playback; seeked catches the clock
		// re-seeking the element (onLoadedMetadata sets currentTime). A paused
		// clock stops both, leaving the last cue on screen — which is correct.
		const update = () => setText(activeCueText(audioEl.currentTime));
		update();
		audioEl.addEventListener("timeupdate", update);
		audioEl.addEventListener("seeked", update);
		return () => {
			audioEl.removeEventListener("timeupdate", update);
			audioEl.removeEventListener("seeked", update);
		};
	}, [audioEl, subtitlesUrl, activeCueText]);

	if (!text) return null;
	return (
		<div className={styles.rsCaptionBand}>
			<span
				className={styles.rsCaptionText}
				style={captionTextStyle(captionStyle)}
				aria-live="polite"
			>
				{text}
			</span>
		</div>
	);
};
