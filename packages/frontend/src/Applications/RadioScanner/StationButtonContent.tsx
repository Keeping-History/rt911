import type React from "react";
import lightOffPng from "./light-off.png";
import lightOnPng from "./light-on.png";
import lightUpcomingPng from "./light-upcoming.png";
import styles from "./RadioScanner.module.scss";
import type { StationStatus } from "./stationGrouping";

interface StationButtonContentProps {
	label: string;
	status: StationStatus;
}

const LIGHTS: Record<StationStatus, { src: string; alt: string }> = {
	"on-air": { src: lightOnPng, alt: "On air" },
	upcoming: { src: lightUpcomingPng, alt: "Upcoming" },
	offline: { src: lightOffPng, alt: "Offline" },
};

/**
 * The inside of one station-strip button: an indicator light beside the
 * station label — lit (light-on.png) while the station has something playing
 * at the current virtual time, amber (light-upcoming.png) while it is quiet
 * but has items queued in the reveal buffer, unlit (light-off.png) otherwise.
 */
export const StationButtonContent: React.FC<StationButtonContentProps> = ({ label, status }) => (
	<div className={styles.rsStationBtnContent}>
		<img
			className={styles.rsStationLight}
			src={LIGHTS[status].src}
			alt={LIGHTS[status].alt}
		/>
		<p className={styles.rsStationSource}>{label}</p>
	</div>
);
