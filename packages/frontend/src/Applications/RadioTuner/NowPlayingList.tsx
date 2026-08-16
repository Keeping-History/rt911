import type React from "react";

// Deliberately empty while the Tuner's list is reworked — the scanner's
// segments/mute/solo contract went away with the old rendering.
type NowPlayingListProps = Record<string, never>;

/**
 * Lists the files currently playing for one station (its in-window segments),
 * each with a mute/unmute toggle. Purely presentational — the caller owns the
 * segment computation, the muted-id state, and the solo state.
 *
 * Forked from RadioScanner's NowPlayingList so the Tuner's list can diverge
 * independently; the marquee, overflow hook, and SCSS module stay shared.
 */
export const NowPlayingList: React.FC<NowPlayingListProps> = () => {
	return (
		<></>
		// The marquee mounts only while the list is wider than the wrapper
		// (useHorizontalOverflow); a fitting list renders as-is instead of
		// crawling pointlessly. react-fast-marquee re-measures via
		// ResizeObserver so it keeps scrolling when the clock swaps segments;
		// it pauses while a solo is active so the soloed row stays put.
		// <div ref={containerRef} className={styles.rsNowPlayingWrapper}>
		// 	{overflowing ? (
		// 		<Marquee direction="left" speed={40} pauseOnHover play={!soloActive}>
		// 			{list}
		// 		</Marquee>
		// 	) : (
		// 		list
		// 	)}
		// </div>
	);
};
