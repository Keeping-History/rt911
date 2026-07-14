import type React from "react";
import Marquee from "./marquee";
import styles from "./RadioScanner.module.scss";
import { useVerticalStackOverflow } from "./useVerticalStackOverflow";

interface StationButtonContentProps {
	label: string;
	offline: boolean;
}

/**
 * The inside of one station-strip button: the station label, plus a scrolling
 * OFFLINE marquee when the station has nothing playing at the current virtual
 * time. The two stack vertically; when the button is too short for both lines
 * (useVerticalStackOverflow), the marquee moves beside the label instead.
 */
export const StationButtonContent: React.FC<StationButtonContentProps> = ({ label, offline }) => {
	const { containerRef, labelRef, extraRef, overflowing } = useVerticalStackOverflow();
	return (
		<div
			ref={containerRef}
			className={`${styles.rsStationBtnContent}${overflowing ? ` ${styles.rsStationBtnContentRow}` : ""}`}
		>
			<p ref={labelRef} className={styles.rsStationSource}>
				{label}
			</p>
			{offline && (
				// div, not p: the marquee renders block divs inside, and <div>
				// inside <p> is invalid HTML (React 19 errors)
				<div ref={extraRef} className={styles.rsStationOffline}>
					<Marquee direction="right" speed={20}>
						<span className={styles.rsOfflineText}>OFFLINE</span>
					</Marquee>
				</div>
			)}
		</div>
	);
};
