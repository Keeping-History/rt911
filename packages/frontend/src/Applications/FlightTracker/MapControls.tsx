import type { FC } from "react";
import { ClassicyButton } from "classicy";
import styles from "./FlightTracker.module.scss";

// Canonical home moves to selectTool.ts with the area-select feature; MapControls
// only needs the mode for its two tool toggles.
export type SelectMode = "off" | "rect" | "circle";

/**
 * The toolbar strip between the window chrome and the map (issue #217).
 * Purely presentational: state and camera access live in FlightTracker
 * (persisted toggles as FlightMap props, one-shot moves via FlightMapHandle).
 */
export interface MapControlsProps {
	globe: boolean;
	threeD: boolean;
	cluster: boolean;
	selectMode: SelectMode;
	onZoomIn(): void;
	onZoomOut(): void;
	onToggleGlobe(): void;
	onToggleThreeD(): void;
	onToggleCluster(): void;
	onSetSelectMode(mode: SelectMode): void;
	onPinpoint(center: [number, number], zoom: number): void;
}

export const MapControls: FC<MapControlsProps> = (p) => (
	<div className={styles.mapControls}>
		<ClassicyButton buttonSize="small" aria-label="Zoom out" onClickFunc={p.onZoomOut}>
			−
		</ClassicyButton>
		<ClassicyButton buttonSize="small" aria-label="Zoom in" onClickFunc={p.onZoomIn}>
			+
		</ClassicyButton>
		<span className={styles.mapControlsDivider} />
		<ClassicyButton
			buttonSize="small"
			aria-label="Globe"
			depressed={p.globe}
			onClickFunc={p.onToggleGlobe}
		>
			Globe
		</ClassicyButton>
		<ClassicyButton
			buttonSize="small"
			aria-label="3D"
			depressed={p.threeD}
			onClickFunc={p.onToggleThreeD}
		>
			3D
		</ClassicyButton>
		<ClassicyButton
			buttonSize="small"
			aria-label="Cluster"
			depressed={p.cluster}
			onClickFunc={p.onToggleCluster}
		>
			Cluster
		</ClassicyButton>
		<span className={styles.mapControlsDivider} />
		<ClassicyButton
			buttonSize="small"
			aria-label="Select rectangle"
			depressed={p.selectMode === "rect"}
			onClickFunc={() => p.onSetSelectMode(p.selectMode === "rect" ? "off" : "rect")}
		>
			▭
		</ClassicyButton>
		<ClassicyButton
			buttonSize="small"
			aria-label="Select circle"
			depressed={p.selectMode === "circle"}
			onClickFunc={() => p.onSetSelectMode(p.selectMode === "circle" ? "off" : "circle")}
		>
			◯
		</ClassicyButton>
	</div>
);
