import type { FC } from "react";
import styles from "./FlightTracker.module.scss";

export interface MapCompassProps {
	// Map bearing in degrees; the needle counter-rotates so red always points
	// at true north on screen.
	bearing: number;
	onReset(): void;
}

/**
 * Classicy-styled compass rose floating over the map's top-right corner
 * (issue #219). Clicking eases the map bearing back to 0; pitch is untouched
 * so 2D/3D mode is preserved.
 */
export const MapCompass: FC<MapCompassProps> = ({ bearing, onReset }) => (
	<button
		type="button"
		className={styles.compass}
		aria-label="Reset bearing to north"
		title="Reset to north"
		onClick={onReset}
	>
		<span
			className={styles.compassNeedle}
			data-testid="compass-needle"
			style={{ transform: `rotate(${-bearing}deg)` }}
		>
			<span className={styles.compassNorth} />
			<span className={styles.compassSouth} />
		</span>
		<span className={styles.compassLabel}>N</span>
	</button>
);
