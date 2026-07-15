import { type FC, useState } from "react";
import { ClassicyButton, ClassicyPopUpMenu } from "classicy";
import { PINPOINTS, pinpointById } from "./mapPinpoints";
import styles from "./FlightTracker.module.scss";

import type { SelectMode } from "./selectTool";

export type { SelectMode };

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

export const MapControls: FC<MapControlsProps> = (p) => {
	// The Pinpoints menu must always display its disabled "Choose…" placeholder
	// (issue #226). ClassicyPopUpMenu keeps the picked value in internal state,
	// so after a fly-to the key bump remounts it back onto the placeholder.
	const [pinpointNonce, setPinpointNonce] = useState(0);
	return (
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
		<span className={styles.mapControlsDivider} />
		<ClassicyPopUpMenu
			key={pinpointNonce}
			id="flight_map_pinpoints"
			label="Pinpoints"
			labelPosition="left"
			labelSize="small"
			size="small"
			placeholder="Choose…"
			options={PINPOINTS.map((pin) => ({ value: pin.id, label: pin.label }))}
			onChangeFunc={(e) => {
				const pin = pinpointById(e.target.value);
				if (!pin) return;
				p.onPinpoint(pin.center, pin.zoom);
				setPinpointNonce((n) => n + 1);
			}}
		/>
	</div>
	);
};
