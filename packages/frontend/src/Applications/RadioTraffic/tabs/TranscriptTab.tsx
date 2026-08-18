import type React from "react";
import { useQuickTimeSubtitles } from "classicy";
import { vttUrl } from "../../../Providers/MediaStream/MediaStreamContext";
import type { CardTabProps } from "./cardTabProps";
import styles from "./cardTabs.module.scss";

/**
 * What is being said, at the position the card is playing.
 *
 * Reuses classicy's subtitle parser rather than fetching and parsing the VTT
 * here — radio-core/CaptionOverlay consumes the same hook the same way, and a
 * second WebVTT parser in the app is a second thing to be wrong about cue
 * timings. `vttUrl` derives the .vtt sibling of the .srt the wire carries;
 * every one of the 814 mp3 items has one.
 *
 * Note the shape that follows from that reuse: useQuickTimeSubtitles exposes a
 * point lookup (`activeCueText(seconds)`), not the cue list, so this panel
 * shows the cue at the playhead rather than a scrolling transcript. That is the
 * right panel for 206x39 sitting under a waveform anyway, but it is a
 * consequence of the parser's surface, not a free choice — a full transcript
 * would need classicy to expose its parsed cues.
 */
export const TranscriptTab: React.FC<CardTabProps> = ({ item, currentTimeSec }) => {
	// Called unconditionally with a possibly-undefined URL: the hook handles it,
	// and a conditional call would break the hook order the moment an item's
	// subtitles arrived or went away.
	const url = vttUrl(item.subtitles);
	const { activeCueText } = useQuickTimeSubtitles(url);

	if (!url) {
		return (
			<div className={styles.rtTabPanel} data-tab="transcript">
				<p className={styles.rtEmpty} data-state="none">
					No transcript.
				</p>
			</div>
		);
	}

	const text = activeCueText(currentTimeSec ?? 0);

	return (
		<div className={styles.rtTabPanel} data-tab="transcript">
			{text ? (
				<p className={styles.rtCue} data-state="cue">
					{text}
				</p>
			) : (
				// Between cues. Marked rather than blank so the panel keeps its
				// height and a reader can tell silence from a failed fetch.
				<p className={styles.rtCueSilent} data-state="silent" aria-hidden="true">
					&mdash;
				</p>
			)}
		</div>
	);
};
