// Camera-follow modes for the tracked flights (issue: flight camera modes).
// A "follow" toggle locks the map camera onto the selected flight and drives it
// every frame from the flight's live extrapolated position/heading; the mode
// picks the framing. Pure geometry only — FlightMap owns the map instance and
// feeds the pose from cameraPose() into map.jumpTo() while following.
//
//  - track:     top-down, north-up, centered on the flight. The default; keeps
//               the caller's current zoom so it only recenters (works whether
//               the map is in 2D or 3D — it just flattens the pitch).
//  - highlight: an elevated forward-looking "hero" shot — bearing along the
//               flight's heading, a slight downward tilt, framed just ahead of
//               the plane so its path fills the view.
//  - cockpit:   a near first-person forward view from the plane — bearing along
//               the heading, a steep tilt toward the horizon, zoomed in close.

export type CameraMode = "track" | "cockpit" | "highlight";

export const CAMERA_MODES: readonly CameraMode[] = ["track", "cockpit", "highlight"] as const;

export const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
	track: "Track",
	cockpit: "Cockpit",
	highlight: "Highlight",
};

export const DEFAULT_CAMERA_MODE: CameraMode = "track";

// Unknown/legacy stored values fall back to the default (no migration needed).
export function normalizeCameraMode(value: unknown): CameraMode {
	return value === "cockpit" || value === "highlight" || value === "track"
		? value
		: DEFAULT_CAMERA_MODE;
}

// The follow camera drives pitch directly, so while it is active the map's
// pitch band is opened all the way up (cockpit needs more than the 3D toggle's
// 60° cap). Restored to the 2D/3D constraints on release.
export const MAX_FOLLOW_PITCH = 85;

export interface CameraTarget {
	lon: number;
	lat: number;
	// Direction of travel, degrees clockwise from north (FlightMotion.headingDeg).
	headingDeg: number;
}

export interface CameraPose {
	center: [number, number];
	zoom: number;
	pitch: number;
	bearing: number;
}

// Per-mode framing. Zoom/pitch are tuning knobs; aheadKm shifts the look-point
// forward along the heading so the plane sits lower in a pitched frame.
const HIGHLIGHT_ZOOM = 9.5;
const HIGHLIGHT_PITCH = 52;
const HIGHLIGHT_AHEAD_KM = 6;
const COCKPIT_ZOOM = 12.5;
const COCKPIT_PITCH = 78;
const COCKPIT_AHEAD_KM = 14;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQ = 111.320;
const DEG = Math.PI / 180;

/**
 * Move a lon/lat by `km` along a compass heading (degrees clockwise from north).
 * Longitude is expanded by 1/cos(lat) so the step is a true ground distance.
 */
export function offsetLngLat(
	lon: number,
	lat: number,
	headingDeg: number,
	km: number,
): [number, number] {
	const h = headingDeg * DEG;
	const dLat = (km * Math.cos(h)) / KM_PER_DEG_LAT;
	const cosLat = Math.max(Math.cos(lat * DEG), 0.01);
	const dLon = (km * Math.sin(h)) / (KM_PER_DEG_LON_EQ * cosLat);
	return [lon + dLon, lat + dLat];
}

/**
 * Camera pose for a followed flight. `currentZoom` is the map's live zoom, used
 * by track mode so enabling follow only recenters (doesn't jump the zoom).
 */
export function cameraPose(
	mode: CameraMode,
	target: CameraTarget,
	currentZoom: number,
): CameraPose {
	const { lon, lat, headingDeg } = target;
	switch (mode) {
		case "cockpit":
			return {
				center: offsetLngLat(lon, lat, headingDeg, COCKPIT_AHEAD_KM),
				zoom: COCKPIT_ZOOM,
				pitch: COCKPIT_PITCH,
				bearing: headingDeg,
			};
		case "highlight":
			return {
				center: offsetLngLat(lon, lat, headingDeg, HIGHLIGHT_AHEAD_KM),
				zoom: HIGHLIGHT_ZOOM,
				pitch: HIGHLIGHT_PITCH,
				bearing: headingDeg,
			};
		case "track":
		default:
			// Top-down, north-up, centered: just recenter at the current zoom.
			return { center: [lon, lat], zoom: currentZoom, pitch: 0, bearing: 0 };
	}
}
