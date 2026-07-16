import { type FC, useState } from "react";
import { ClassicyButton, ClassicyPopUpMenu } from "classicy";
import { PINPOINTS, pinpointById } from "./mapPinpoints";
import styles from "./FlightTracker.module.scss";
import {
	type BasemapStyleId,
	normalizeBasemapStyle,
} from "../../lib/basemap/basemapStyles";

import type { SelectMode } from "./selectTool";

export type { SelectMode };

// Same ids/labels as the Settings dialog and View menu — three UIs, one setting.
const MAP_STYLE_OPTIONS: { value: BasemapStyleId; label: string }[] = [
	{ value: "classic", label: "Classic" },
	{ value: "radar", label: "Radar" },
	{ value: "satellite", label: "Satellite" },
];

/**
 * The toolbar strip between the window chrome and the map (issue #217).
 * Purely presentational: state and camera access live in FlightTracker
 * (persisted toggles as FlightMap props, one-shot moves via FlightMapHandle).
 */
export interface MapControlsProps {
	globe: boolean;
	threeD: boolean;
	terrain: boolean;
	cluster: boolean;
	selectMode: SelectMode;
	mapStyle: BasemapStyleId;
	darkMap: boolean;
	filterOn: boolean;
	onZoomIn(): void;
	onZoomOut(): void;
	onToggleGlobe(): void;
	onToggleThreeD(): void;
	onToggleTerrain(): void;
	onToggleCluster(): void;
	onSetSelectMode(mode: SelectMode): void;
	onPinpoint(center: [number, number], zoom: number): void;
	onSetMapStyle(style: BasemapStyleId): void;
	onToggleDarkMap(): void;
	onOpenFilter(): void;
}

export const MapControls: FC<MapControlsProps> = (p) => {
	// The Pinpoints menu must always display its disabled "Choose…" placeholder
	// (issue #226). ClassicyPopUpMenu keeps the picked value in internal state,
	// so after a fly-to the key bump remounts it back onto the placeholder.
	const [pinpointNonce, setPinpointNonce] = useState(0);
	return (
	<div className={styles.mapControls}>
		<div className={styles.mapControlsContainer}>
		<ClassicyButton buttonSize="small" aria-label="Zoom out" onClickFunc={p.onZoomOut}>
			−
		</ClassicyButton>
		<ClassicyButton buttonSize="small" aria-label="Zoom in" onClickFunc={p.onZoomIn}>
			+
		</ClassicyButton>
		</div>
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
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
			aria-label="Terrain"
			depressed={p.terrain}
			onClickFunc={p.onToggleTerrain}
		>
			Terrain
		</ClassicyButton>
		<ClassicyButton
			buttonSize="small"
			aria-label="Cluster"
			depressed={p.cluster}
			onClickFunc={p.onToggleCluster}
		>
			Cluster
		</ClassicyButton>
		</div>
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
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
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
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
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
		<ClassicyPopUpMenu
			id="flight_map_style"
			label="Style"
			labelPosition="left"
			labelSize="small"
			size="small"
			selected={p.mapStyle}
			options={MAP_STYLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
			onChangeFunc={(e) => p.onSetMapStyle(normalizeBasemapStyle(e.target.value))}
		/>
		<ClassicyButton
			buttonSize="small"
			aria-label="Dark map"
			// A radar scope is inherently dark (effectiveTone ignores the flag),
			// so the toggle goes dead and unpressed there — but the stored darkMap
			// preference is kept, ready for the next non-radar style.
			disabled={p.mapStyle === "radar"}
			depressed={p.mapStyle !== "radar" && p.darkMap}
			onClickFunc={p.onToggleDarkMap}
		>
			Dark
		</ClassicyButton>
		</div>
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
		<ClassicyButton
			buttonSize="small"
			aria-label="Filter flights"
			depressed={p.filterOn}
			onClickFunc={p.onOpenFilter}
		>
			{p.filterOn ? "Filter (on)…" : "Filter…"}
		</ClassicyButton>
		</div>
	</div>
	);
};
