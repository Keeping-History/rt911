import { type FC, useState } from "react";
import {
	ClassicyBalloonHelp,
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyPopUpMenu,
} from "classicy";
import { PINPOINTS, pinpointById } from "./mapPinpoints";
import styles from "./FlightTracker.module.scss";
import mapGlobePng from "./map-globe.png";
import map3dPng from "./map-3d.png";
import mapTerrainPng from "./map-terrain.png";
import mapClusterPng from "./map-cluster.png";
import mapAirportPng from "./map-airport.png";
import mapPlanePng from "./map-plane.png";
import mapCameraPng from "./map-camera.png";
import mapPalettePng from "./map-pallette.png";
import {
	type BasemapStyleId,
	normalizeBasemapStyle,
} from "../../lib/basemap/basemapStyles";
import {
	type CameraMode,
	CAMERA_MODE_LABELS,
	CAMERA_MODES,
	normalizeCameraMode,
} from "./flightCamera";

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
	// Camera-follow (tracked flights): `cameraMode` is the dropdown framing;
	// `cameraFollow` is true while the camera is locked onto a flight; `canFollow`
	// is true when a tracked flight is selected (so the toggle can arm).
	cameraMode: CameraMode;
	cameraFollow: boolean;
	canFollow: boolean;
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
	onClearFilter(): void;
	onSetCameraMode(mode: CameraMode): void;
	onToggleCameraFollow(): void;
}

export const MapControls: FC<MapControlsProps> = (p) => {
	// The Pinpoints menu must always display its disabled "Choose…" placeholder
	// (issue #226). ClassicyPopUpMenu keeps the picked value in internal state,
	// so after a fly-to the key bump remounts it back onto the placeholder.
	const [pinpointNonce, setPinpointNonce] = useState(0);
	return (
	<div className={styles.mapControls}>
		<div className={styles.mapControlsContainer}>
		{/* Zoom is the camera's domain while a follow lock is active. */}
		<ClassicyBalloonHelp content="Zoom the map out to see a wider area.">
		<ClassicyButton
			buttonSize="small"
			aria-label="Zoom out"
			disabled={p.cameraFollow}
			onClickFunc={p.onZoomOut}
			margin="sm"
		>
			−
		</ClassicyButton>
		</ClassicyBalloonHelp>
		<ClassicyBalloonHelp content="Zoom the map in for a closer view.">
		<ClassicyButton
			buttonSize="small"
			aria-label="Zoom in"
			margin="sm"
			disabled={p.cameraFollow}
			onClickFunc={p.onZoomIn}
		>
			+
		</ClassicyButton>
		</ClassicyBalloonHelp>
		</div>
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
		<ClassicyBalloonHelp content="Switch the map between a flat projection and a 3-D globe.">
		<ClassicyButton
			buttonSize="small"
			aria-label="Globe"
			margin="sm"
			depressed={p.globe}
			onClickFunc={p.onToggleGlobe}
		>
			<img className={styles.mapControlIcon} src={mapGlobePng} alt="" />
		</ClassicyButton>
		</ClassicyBalloonHelp>
		<ClassicyBalloonHelp content="Tilt the map into a three-dimensional perspective.">
		<ClassicyButton
			buttonSize="small"
			aria-label="3D"
			margin="sm"
			depressed={p.threeD}
			onClickFunc={p.onToggleThreeD}
		>
			<img className={styles.mapControlIcon} src={map3dPng} alt="" />
		</ClassicyButton>
		</ClassicyBalloonHelp>
		<ClassicyBalloonHelp content="Show shaded elevation so mountains and valleys stand out.">
		<ClassicyButton
			buttonSize="small"
			aria-label="Terrain"
			margin="sm"
			depressed={p.terrain}
			onClickFunc={p.onToggleTerrain}
		>
			<img className={styles.mapControlIcon} src={mapTerrainPng} alt="" />
		</ClassicyButton>
		</ClassicyBalloonHelp>
		<ClassicyBalloonHelp content="Group nearby flights into a single marker to reduce clutter.">
		<ClassicyButton
			buttonSize="small"
			aria-label="Cluster"
			margin="sm"
			depressed={p.cluster}
			onClickFunc={p.onToggleCluster}
		>
			<img className={styles.mapControlIcon} src={mapClusterPng} alt="" />
		</ClassicyButton>
		</ClassicyBalloonHelp>
		</div>
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
		{/* The marquee selectors move/read the map, so they lock out while following. */}
		<ClassicyBalloonHelp content="Drag a rectangle on the map to select the flights inside it.">
		<ClassicyButton
			buttonSize="small"
			margin="sm"
			aria-label="Select rectangle"
			depressed={p.selectMode === "rect"}
			disabled={p.cameraFollow}
			onClickFunc={() => p.onSetSelectMode(p.selectMode === "rect" ? "off" : "rect")}
		>
			<span className={styles.mapControlGlyph}>▭</span>
		</ClassicyButton>
		</ClassicyBalloonHelp>
		<ClassicyBalloonHelp content="Drag a circle on the map to select the flights inside it.">
		<ClassicyButton
			buttonSize="small"
			margin="sm"
			aria-label="Select circle"
			depressed={p.selectMode === "circle"}
			disabled={p.cameraFollow}
			onClickFunc={() => p.onSetSelectMode(p.selectMode === "circle" ? "off" : "circle")}
		>
			<span className={styles.mapControlGlyph}>◯</span>
		</ClassicyButton>
		</ClassicyBalloonHelp>
		</div>
		<span className={styles.mapControlsDivider} />
		{/* Camera follow (tracked flights): a toggle that locks the camera onto
		    the selected flight, and a dropdown picking the framing. The plane icon
		    to the left of the (now icon-only) toggle marks the camera group. */}
		<div className={styles.mapControlsContainer}>
		<img className={styles.followPlaneIcon} src={mapPlanePng} alt="" />
		<ClassicyBalloonHelp content="Lock the camera onto the selected flight and follow it as it moves. Available when a tracked flight is selected.">
		<ClassicyCheckbox
			id="flight_camera_follow"
			checked={p.cameraFollow}
			disabled={!p.canFollow}
			// onClickFunc reports the new checked state; onToggleCameraFollow just
			// flips the (controlled) cameraFollow flag, so the arg is ignored.
			onClickFunc={() => p.onToggleCameraFollow()}
		/>
		</ClassicyBalloonHelp>
		{/* Camera icon marks the framing dropdown (like the airport icon by Pinpoints). */}
		<img className={styles.mapControlIcon} src={mapCameraPng} alt="Camera" />
		<ClassicyBalloonHelp content="Choose how the camera frames the flight you are following.">
		<ClassicyPopUpMenu
			id="flight_camera_mode"
			size="small"
			selected={p.cameraMode}
			options={CAMERA_MODES.map((m) => ({ value: m, label: CAMERA_MODE_LABELS[m] }))}
			onChangeFunc={(e) => p.onSetCameraMode(normalizeCameraMode(e.target.value))}
		/>
		</ClassicyBalloonHelp>
		</div>
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
		{/* The airport icon stands in for the old "Pinpoints" text label. */}
		<img className={styles.mapControlIcon} src={mapAirportPng} alt="Pinpoints" />
		<ClassicyBalloonHelp content="Jump the map to a notable airport or location.">
		<ClassicyPopUpMenu
			key={pinpointNonce}
			id="flight_map_pinpoints"
			size="small"
			// A pinpoint fly-to would fight the follow lock, so it's disabled then.
			disabled={p.cameraFollow}
			placeholder="Choose…"
			options={PINPOINTS.map((pin) => ({ value: pin.id, label: pin.label }))}
			onChangeFunc={(e) => {
				const pin = pinpointById(e.target.value);
				if (!pin) return;
				p.onPinpoint(pin.center, pin.zoom);
				setPinpointNonce((n) => n + 1);
			}}
		/>
		</ClassicyBalloonHelp>
		</div>
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
		{/* Palette icon replaces the old "Style" text label (like airport/camera). */}
		<img className={styles.mapControlIcon} src={mapPalettePng} alt="Style" />
		<ClassicyBalloonHelp content="Choose the map's base style: Classic, Radar, or Satellite.">
		<ClassicyPopUpMenu
			id="flight_map_style"
			size="small"
			selected={p.mapStyle}
			options={MAP_STYLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
			onChangeFunc={(e) => p.onSetMapStyle(normalizeBasemapStyle(e.target.value))}
		/>
		</ClassicyBalloonHelp>
		<ClassicyBalloonHelp content="Use a dark color scheme for the map. Unavailable in Radar style.">
		<ClassicyButton
			buttonSize="small"
			margin="sm"
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
		</ClassicyBalloonHelp>
		</div>
		<span className={styles.mapControlsDivider} />
		<div className={styles.mapControlsContainer}>
		<ClassicyBalloonHelp content="Open the filter panel to show only flights that match your criteria.">
		<ClassicyButton
			buttonSize="small"
			margin="sm"
			aria-label="Filter flights"
			depressed={p.filterOn}
			onClickFunc={p.onOpenFilter}
		>
			{p.filterOn ? "Filter (on)…" : "Filter…"}
		</ClassicyButton>
		</ClassicyBalloonHelp>
		<ClassicyBalloonHelp content="Remove the active filter and show every flight again.">
		<ClassicyButton
			buttonSize="small"
			margin="sm"
			aria-label="Clear filter"
			disabled={!p.filterOn}
			onClickFunc={p.onClearFilter}
		>
			Clear Filter
		</ClassicyButton>
		</ClassicyBalloonHelp>
		</div>
	</div>
	);
};
