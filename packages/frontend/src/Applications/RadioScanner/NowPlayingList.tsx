import { ClassicyIcons } from "classicy";
import type React from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import styles from "./RadioScanner.module.scss";
import Marquee from "./marquee";

interface NowPlayingListProps {
	segments: MediaItem[];
	mutedItems: number[];
	onToggleMute: (id: number) => void;
}

const soundOn = ClassicyIcons.controlPanels.soundManager.soundOn as string;
const soundMute = ClassicyIcons.controlPanels.soundManager.soundMute as string;

/**
 * Lists the files currently playing for one station (its in-window segments),
 * each with a mute/unmute toggle. Purely presentational — the caller owns the
 * segment computation and the muted-id state.
 */
export const NowPlayingList: React.FC<NowPlayingListProps> = ({
	segments,
	mutedItems,
	onToggleMute,
}) => {
	if (segments.length === 0) {
		return <p className={styles.rsNowPlayingEmpty}>—</p>;
	}
	return (
		<Marquee direction="left" speed={40} pauseOnHover>
			<ul className={styles.rsNowPlaying}>
				{segments.map((item) => {
					const isMuted = mutedItems.includes(item.id);
					return (
						<li key={item.id} className={styles.rsNowPlayingRow}>
							<button
								type="button"
								className={styles.rsNowPlayingBtn}
								onMouseUp={() => onToggleMute(item.id)}
								aria-pressed={isMuted}
							>
								<img src={isMuted ? soundMute : soundOn} alt={isMuted ? "Unmute" : "Mute"} />
							</button>
							{/* Per-title marquee; react-fast-marquee re-measures via
								ResizeObserver so it keeps scrolling when the clock swaps
								segments (react-marquee-text froze on content change). */}
								<span className={styles.rsNowPlayingTitle}>{item.full_title || item.title}</span>
						</li>
					);
				})}
			</ul>
		</Marquee>
	);
};
