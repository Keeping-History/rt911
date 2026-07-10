import { ClassicyIcons } from "classicy";
import type React from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import styles from "./RadioScanner.module.scss";
import Marquee from "./marquee";
import { useHorizontalOverflow } from "./useHorizontalOverflow";

interface NowPlayingListProps {
	segments: MediaItem[];
	mutedItems: number[];
	onToggleMute: (id: number) => void;
	// Solo: clicking a title mutes every other playing item and pauses the
	// marquee; clicking it again restores the manual mute state. null = off.
	soloItemId: number | null;
	onToggleSolo: (id: number) => void;
}

const soundOn = ClassicyIcons.controlPanels.soundManager.soundOn as string;
const soundMute = ClassicyIcons.controlPanels.soundManager.soundMute as string;

/**
 * Lists the files currently playing for one station (its in-window segments),
 * each with a mute/unmute toggle. Purely presentational — the caller owns the
 * segment computation, the muted-id state, and the solo state.
 */
export const NowPlayingList: React.FC<NowPlayingListProps> = ({
	segments,
	mutedItems,
	onToggleMute,
	soloItemId,
	onToggleSolo,
}) => {
	const { containerRef, contentRef, overflowing } = useHorizontalOverflow();
	if (segments.length === 0) {
		return <p className={styles.rsNowPlayingEmpty}>—</p>;
	}
	const soloActive = soloItemId !== null;
	const list = (
		<ul
			ref={contentRef}
			className={`${styles.rsNowPlaying}${overflowing ? ` ${styles.rsNowPlayingScrolling}` : ""}`}
		>
			{segments.map((item) => {
				// While soloed, display mirrors what's audible: only the soloed
				// item plays, regardless of manual mutes (which stay untouched).
				const isMuted = soloActive ? item.id !== soloItemId : mutedItems.includes(item.id);
				const isSoloed = soloItemId === item.id;
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
						<button
							type="button"
							className={`${styles.rsNowPlayingTitleBtn}${isSoloed ? ` ${styles.rsNowPlayingSolo}` : ""}`}
							onClick={() => onToggleSolo(item.id)}
							aria-pressed={isSoloed}
							title={isSoloed ? "Unsolo (unmute the rest)" : "Solo (mute the rest)"}
						>
							<span className={styles.rsNowPlayingTitle}>{item.full_title || item.title}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
	return (
		// The marquee mounts only while the list is wider than the wrapper
		// (useHorizontalOverflow); a fitting list renders as-is instead of
		// crawling pointlessly. react-fast-marquee re-measures via
		// ResizeObserver so it keeps scrolling when the clock swaps segments;
		// it pauses while a solo is active so the soloed row stays put.
		<div ref={containerRef} className={styles.rsNowPlayingWrapper}>
			{overflowing ? (
				<Marquee direction="left" speed={40} pauseOnHover play={!soloActive}>
					{list}
				</Marquee>
			) : (
				list
			)}
		</div>
	);
};
