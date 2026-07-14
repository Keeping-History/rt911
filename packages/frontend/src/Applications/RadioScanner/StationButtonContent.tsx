import type React from "react";
import lightOffPng from "./light-off.png";
import lightOnPng from "./light-on.png";
import styles from "./RadioScanner.module.scss";

interface StationButtonContentProps {
	label: string;
	offline: boolean;
}

/**
 * The inside of one station-strip button: an on-air indicator light beside the
 * station label — lit (light-on.png) while the station has something playing
 * at the current virtual time, unlit (light-off.png) while it is offline.
 */
export const StationButtonContent: React.FC<StationButtonContentProps> = ({ label, offline }) => (
	<div className={styles.rsStationBtnContent}>
		<img
			className={styles.rsStationLight}
			src={offline ? lightOffPng : lightOnPng}
			alt={offline ? "Offline" : "On air"}
		/>
		<p className={styles.rsStationSource}>{label}</p>
	</div>
);
