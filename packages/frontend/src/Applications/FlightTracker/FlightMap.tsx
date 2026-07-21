import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { type FC, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MapCompass } from "./MapCompass";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightFeatureCollection } from "./flightGeoJSON";
import { basemapPalette, pixelPlanes, TERRAIN_SOURCE } from "../../lib/basemap/basemapStyles";
import {
	type BasemapStyleId,
	type BasemapUrls,
	TRACK_LINE_COLOR,
	TRACK_SHADOW_COLOR,
	applyMapColors,
	buildBasemapStyle,
	type FlightMapColors,
	highlightTrailColor,
	trailColor,
	trailGradient,
} from "./flightMapStyle";
import planeSvg from "./plane.svg?raw";
import pinSvg from "./pin.svg?raw";
import type { MapPoi } from "./mapPois";
import {
	PLANE_ICON_ID,
	PLANE_ICON_PX,
	PLANE_NOTABLE_ICON_ID,
	PLANE_NOTABLE_ICON_PX,
	PLANE_OBSERVER_ICON_ID,
	buildPlaneImage,
	familyIconId,
	familyIconPx,
	familyNotableIconId,
	familyNotableIconPx,
	familyObserverIconId,
	iconDisplayPx,
} from "./flightIcons";
import {
	type FlightMotion,
	type LandingClock,
	type MotionBuffer,
	TRAIL_MULTIPLIER_MAX,
	TRAIL_POINTS,
	extrapolate,
	motionNow,
	motionPointsToGeoJSON,
	motionTrailsToGeoJSON,
	seedMotionFromHistory,
	updateMotion,
} from "./flightMotion";
import {
	RADAR_FALLBACK_COLOR,
	resolveCssColor,
	sweepLineGeoJSON,
	sweepTrailGeoJSON,
} from "./flightRadar";
import {
	ALT_EXAGGERATION,
	type AltitudeSample,
	altitudeFtAt,
	exaggeratedHeightM,
	kmPerPixel,
	plane3DTargetPx,
} from "./flightAltitude";
import { buildTrackTube, buildTrailTubes } from "./trackTube";
import { TrackTube3DLayer } from "./trackTubeLayer";
import { buildPlaneInstanceBatches, buildSphereMesh } from "./plane3dMesh";
import { type AircraftFamily, loadAircraftMesh } from "./aircraftModels";
import { loadAircraftIconSvg } from "./aircraftIcons";
import { Planes3DLayer } from "./planes3DLayer";
import {
	type DragPixels,
	type SelectMode,
	dragBounds,
	insideSelection,
	overlayStyle,
} from "./selectTool";
import styles from "./FlightTracker.module.scss";
import {
	type ReplayBuffer,
	buildReplayTrailInstances,
	replayPointsAt,
} from "./flightReplay";
import { type LoopClock, playheadAt } from "./loopClock";
import {
	type CameraMode,
	cameraPose,
	MAX_FOLLOW_PITCH,
} from "./flightCamera";

// Register the pmtiles:// protocol once per page (adding it twice throws).
let protocolRegistered = false;
function ensurePmtilesProtocol() {
	if (protocolRegistered) return;
	maplibregl.addProtocol("pmtiles", new Protocol().tile);
	protocolRegistered = true;
}

// Build both plane images and (re)install them. updateImage on a color change
// keeps the symbol layers untouched. Never throws into React — on failure the
// map just has no plane icons (prod browsers always have canvas; jsdom tests
// mock this module).
async function installPlaneIcons(
	map: maplibregl.Map,
	pinColor: string,
	notablePinColor: string,
	observerPinColor: string,
	pixelate: boolean,
) {
	try {
		const [regular, notable, observer] = await Promise.all([
			buildPlaneImage(planeSvg, pinColor, iconDisplayPx(PLANE_ICON_PX, pixelate), pixelate),
			buildPlaneImage(planeSvg, notablePinColor, PLANE_NOTABLE_ICON_PX, pixelate),
			buildPlaneImage(planeSvg, observerPinColor, PLANE_NOTABLE_ICON_PX, pixelate),
		]);
		if (map.hasImage(PLANE_ICON_ID)) map.updateImage(PLANE_ICON_ID, regular);
		else map.addImage(PLANE_ICON_ID, regular, { pixelRatio: 2 });
		if (map.hasImage(PLANE_NOTABLE_ICON_ID)) map.updateImage(PLANE_NOTABLE_ICON_ID, notable);
		else map.addImage(PLANE_NOTABLE_ICON_ID, notable, { pixelRatio: 2 });
		if (map.hasImage(PLANE_OBSERVER_ICON_ID)) map.updateImage(PLANE_OBSERVER_ICON_ID, observer);
		else map.addImage(PLANE_OBSERVER_ICON_ID, observer, { pixelRatio: 2 });
	} catch (err) {
		console.warn("plane icons unavailable:", err);
	}
}

// Per-family silhouette variant of installPlaneIcons: same colorize +
// rasterize pipeline, at the family's relative display size.
async function installFamilyIcon(
	map: maplibregl.Map,
	family: string,
	svg: string,
	pinColor: string,
	notablePinColor: string,
	observerPinColor: string,
	pixelate: boolean,
) {
	try {
		const [regular, notable, observer] = await Promise.all([
			buildPlaneImage(svg, pinColor, iconDisplayPx(familyIconPx(family), pixelate), pixelate),
			buildPlaneImage(svg, notablePinColor, familyNotableIconPx(family), pixelate),
			buildPlaneImage(svg, observerPinColor, familyNotableIconPx(family), pixelate),
		]);
		const id = familyIconId(family);
		const notableId = familyNotableIconId(family);
		const observerId = familyObserverIconId(family);
		if (map.hasImage(id)) map.updateImage(id, regular);
		else map.addImage(id, regular, { pixelRatio: 2 });
		if (map.hasImage(notableId)) map.updateImage(notableId, notable);
		else map.addImage(notableId, notable, { pixelRatio: 2 });
		if (map.hasImage(observerId)) map.updateImage(observerId, observer);
		else map.addImage(observerId, observer, { pixelRatio: 2 });
	} catch (err) {
		console.warn(`family icon ${family} unavailable:`, err);
	}
}

// Data-driven icon choice: the family's silhouette once its image has
// registered, the generic icon until then (["image", id] only resolves for
// registered images, so coalesce falls through cleanly). Prefixes must
// match flightIcons.familyIconId / familyNotableIconId.
const FAMILY_ICON_IMAGE = [
	"coalesce",
	["image", ["concat", "plane-", ["get", "family"]]],
	["image", PLANE_ICON_ID],
] as unknown as maplibregl.ExpressionSpecification;
const FAMILY_NOTABLE_ICON_IMAGE = [
	"coalesce",
	["image", ["concat", "plane-notable-", ["get", "family"]]],
	["image", PLANE_NOTABLE_ICON_ID],
] as unknown as maplibregl.ExpressionSpecification;
const FAMILY_OBSERVER_ICON_IMAGE = [
	"coalesce",
	["image", ["concat", "plane-observer-", ["get", "family"]]],
	["image", PLANE_OBSERVER_ICON_ID],
] as unknown as maplibregl.ExpressionSpecification;
// The highlight layer serves both categories; the flag picks the icon set.
const HIGHLIGHT_ICON_IMAGE = [
	"case",
	["==", ["get", "observer"], true],
	FAMILY_OBSERVER_ICON_IMAGE,
	FAMILY_NOTABLE_ICON_IMAGE,
] as unknown as maplibregl.ExpressionSpecification;

// Kick off (once per family) the silhouette fetch for every family in view;
// on arrival, rasterize + register both color variants. "generic" never
// fetches — the fallback icon IS the generic art. Callers pass live refs so
// late-resolving fetches see the current map/colors (or bail if unmounted).
function requestFamilyIcons(
	fc: FlightFeatureCollection,
	requested: Set<string>,
	loaded: Map<string, string>,
	mapRef: { current: maplibregl.Map | null },
	colorsRef: { current: FlightMapColors },
) {
	for (const f of fc.features) {
		const family = f.properties.family;
		if (!family || family === "generic" || requested.has(family)) continue;
		requested.add(family);
		void loadAircraftIconSvg(family as AircraftFamily).then((svg) => {
			const map = mapRef.current;
			if (!svg || !map) return;
			loaded.set(family, svg);
			void installFamilyIcon(
				map, family, svg,
				colorsRef.current.pinColor, colorsRef.current.notablePinColor,
				colorsRef.current.observerPinColor, pixelPlanes(colorsRef.current.mapStyle),
			);
		});
	}
}

export const POI_PIN_ICON_ID = "poi-pin";
export const POI_PIN_PX = 18; // display size; rasterized at 2×
export const POI_LAYER_IDS = ["poi-clusters", "poi-cluster-counts", "poi-pins", "map-poi-selected"];
const POI_SELECTED_SCALE = 1.25;

/** POIs → point features carrying id/name/iata for the pin label + hit-test. */
export function poisToGeoJSON(pois: MapPoi[]): GeoJSON.FeatureCollection {
	return {
		type: "FeatureCollection",
		features: pois.map((p) => ({
			type: "Feature",
			geometry: { type: "Point", coordinates: [p.lon, p.lat] },
			properties: { id: p.id, name: p.name, iata: p.iata ?? "", layer: p.layer },
		})),
	};
}

async function installPoiIcon(map: maplibregl.Map, color: string, pixelate: boolean) {
	try {
		const img = await buildPlaneImage(pinSvg, color, POI_PIN_PX, pixelate);
		if (map.hasImage(POI_PIN_ICON_ID)) map.updateImage(POI_PIN_ICON_ID, img);
		else map.addImage(POI_PIN_ICON_ID, img, { pixelRatio: 2 });
	} catch (err) {
		console.warn("poi pin icon unavailable:", err);
	}
}

/**
 * Transient camera commands for MapControls (zoom/pinpoints/compass). The
 * persisted toggles (globe/cluster/3D) stay declarative props; only one-shot
 * camera moves go through this imperative seam — no consumer ever touches the
 * raw MapLibre instance.
 */
export interface FlightMapHandle {
	zoomIn(): void;
	zoomOut(): void;
	flyTo(center: [number, number], zoom: number): void;
	resetNorth(): void;
}

interface FlightMapProps {
	ref?: Ref<FlightMapHandle>;
	positions: FlightPosition[];
	// Short history lookback from the provider (flightsSeed): earlier samples
	// that give freshly-seeded single-sample flights a heading immediately.
	seedPositions?: FlightPosition[];
	basemapUrls: BasemapUrls;
	trackGeoJSON: GeoJSON.Feature | null;
	// Raw altitude profile of the selected flight: the smooth 3D track tube
	// splines it in all three axes (see trackTube.ts).
	trackProfile?: AltitudeSample[] | null;
	nowMs: number;
	playing: boolean;
	mapStyle: BasemapStyleId;
	darkMap: boolean;
	// CSS hex strings — FlightTracker converts from the persisted packed ints.
	pinColor: string;
	notablePinColor: string;
	observerPinColor: string;
	radarSweep: boolean;
	// Comet-tail length as a multiple of TRAIL_POINTS; 0 turns tails off.
	trailMultiplier: number;
	// Loop mode (optional with idle defaults so non-loop call sites stay simple):
	// while enabled, replay-trail pins replay replayBuffer at the loopClock's playhead,
	// wrapped into the sliding [now − loopWindowMs, now) window.
	loopEnabled?: boolean;
	loopWindowMs?: number;
	loopClock?: LoopClock;
	replayBuffer?: ReplayBuffer;
	// Filter Flights (issue #188): replay trails of flights outside this set are
	// skipped at draw time; null/omitted shows all. Live pins are filtered
	// upstream by FlightTracker via the positions array itself.
	visibleFlights?: Set<string> | null;
	// flight → wheels-down/crash UTC ms (flightLanding.landingClockOf): every
	// dead-reckoning builder clamps to it, freezing landed flights at their
	// track end instead of gliding past the runway.
	landingClock?: LandingClock;
	// MapControls toggles (issues #218/#222/#223); persisted in FlightMapSettings.
	globe?: boolean;
	threeD?: boolean;
	// Topography (hillshade + 3D ground mesh); persisted in FlightMapSettings.
	terrain?: boolean;
	cluster?: boolean;
	// Area-select tool (issue #225): while armed, drags trace a rectangle or
	// circle instead of panning; the release reports the flights inside.
	selectMode?: SelectMode;
	onAreaSelect?: (flights: string[]) => void;
	// Fires when the camera crosses the pitched threshold in either direction —
	// FlightTracker keeps the 3D toggle in sync with manual z-axis drags.
	onPitchedChange?: (pitched: boolean) => void;
	// Airframe family for a flight (aircraftModels.familyForAircraftType via
	// the route index) — picks which 3D model its instances render with.
	aircraftFamilyOf?: (flight: string, startDate: string) => string;
	// Camera follow (tracked flights): while `followFlight` is a callsign the
	// camera locks onto that flight every frame in `cameraMode`'s framing, and
	// user pan/zoom/rotate are disabled. null/omitted = free camera.
	followFlight?: string | null;
	cameraMode?: CameraMode;
	onSelectFlight: (flight: string) => void;
	onClearSelection: () => void;
	// POI markers (airports, etc.) — enabled set computed by FlightTracker.
	pois?: MapPoi[];
	selectedPoiId?: number | null;
	onSelectPoi?: (poi: MapPoi) => void;
}

// Enable/disable every user camera handler in one place (the follow lock owns
// the camera while active). Defensive against handlers a given build/mock may
// not expose — only dragPan is guaranteed in the test harness.
type MapHandler = { enable?: () => void; disable?: () => void };
function setCameraInteractive(map: maplibregl.Map, on: boolean) {
	const m = map as unknown as Record<string, MapHandler | undefined>;
	for (const key of [
		"dragPan", "dragRotate", "scrollZoom", "boxZoom",
		"doubleClickZoom", "keyboard", "touchZoomRotate", "touchPitch",
	]) {
		const h = m[key];
		if (on) h?.enable?.();
		else h?.disable?.();
	}
}

// Restore the pitch band to the 2D/3D toggle's constraints (mirrors the threeD
// effect's ordering — maplibre rejects min > max).
function restorePitchConstraints(map: maplibregl.Map, threeD: boolean) {
	if (threeD) {
		map.setMaxPitch(THREE_D_PITCH);
		map.setMinPitch(THREE_D_MIN_PITCH);
	} else {
		map.setMinPitch(0);
		map.setMaxPitch(0);
	}
}

/** Non-highlighted features only — notables and observers never cluster (issue #222). */
export function nonNotableFeatures(fc: FlightFeatureCollection): FlightFeatureCollection {
	return {
		type: "FeatureCollection",
		features: fc.features.filter(
			(f) => f.properties.notable !== true && f.properties.observer !== true,
		),
	};
}

// Representative lng/lat for a hit-test feature: the point itself, or a 3D
// plane slab's first ring vertex (close enough at marker scale for
// nearest-hit ranking and circle-radius refinement).
function featureAnchor(f: { geometry: GeoJSON.Geometry }): [number, number] | null {
	if (f.geometry.type === "Point") return f.geometry.coordinates as [number, number];
	if (f.geometry.type === "Polygon") return f.geometry.coordinates[0][0] as [number, number];
	return null;
}

// Screen position of a location AT ALTITUDE, or null when it's hidden behind
// the planet. queryRenderedFeatures hit-tests ground footprints, not the
// visually elevated pixels — so 3D hit tests project the elevated point
// themselves, via per-projection INTERNAL transform methods (absent from the
// public types, present in every 5.x build; verified live):
//  - mercator: transform.coordinatePoint(mercCoord, elevationMeters)
//  - globe: transform.projectTileCoordinates(x, y, tileID, getElevation) —
//    the CPU twin of the shaders' projectTileFor3D. A synthetic zoom-0 tile
//    makes in-tile coords = mercator × EXTENT, and the result is NDC, so it
//    converts through the transform's canvas size. Occluded points (far side
//    of the sphere) return null rather than a bogus mirror position.
// If both are missing (or throw), fall back to the ground projection — no
// worse than the pre-fix behavior.
const TILE_EXTENT = 8192;
const WORLD_TILE = { wrap: 0, canonical: { x: 0, y: 0, z: 0 } };
function projectAtAltitude(
	map: maplibregl.Map,
	lon: number,
	lat: number,
	altM: number,
): { x: number; y: number } | null {
	const transform = (
		map as unknown as {
			transform?: {
				coordinatePoint?: (
					coord: maplibregl.MercatorCoordinate,
					elevation: number,
				) => { x: number; y: number };
				// Exaggerated terrain height at the camera center; 0 without terrain.
				elevation?: number;
				projectTileCoordinates?: (
					x: number,
					y: number,
					tileID: typeof WORLD_TILE,
					getElevation: () => number,
				) => { point: { x: number; y: number }; isOccluded?: boolean };
				width?: number;
				height?: number;
			};
		}
	).transform;
	try {
		if (transform?.coordinatePoint) {
			// coordinatePoint's pixel matrix is built BEFORE MapLibre's terrain
			// "elevate camera over terrain" translate, but custom layers render
			// through the view-proj matrix built AFTER it — so with terrain on,
			// the shader draws aircraft transform.elevation meters lower than
			// this predicts. Subtracting it projects exactly where the plane is
			// drawn; without terrain, elevation is 0 and this is a no-op.
			return transform.coordinatePoint(
				maplibregl.MercatorCoordinate.fromLngLat([lon, lat]),
				altM - (transform.elevation ?? 0),
			);
		}
		if (transform?.projectTileCoordinates && transform.width && transform.height) {
			const merc = maplibregl.MercatorCoordinate.fromLngLat([lon, lat]);
			const p = transform.projectTileCoordinates(
				merc.x * TILE_EXTENT,
				merc.y * TILE_EXTENT,
				WORLD_TILE,
				() => altM,
			);
			if (p.isOccluded) return null;
			return {
				x: ((p.point.x + 1) / 2) * transform.width,
				y: ((1 - p.point.y) / 2) * transform.height,
			};
		}
	} catch {
		// fall through to ground projection
	}
	return map.project([lon, lat]);
}

/**
 * Single resolver for the pitch × cluster × projection layer matrix (one
 * writer — split writers previously stomped each other's visibility).
 * Pitched: aircraft render in true 3D (flat icons AND flat cluster blobs
 * hide); flat: cluster decides between icons and blobs. All pitched 3D
 * geometry comes from the custom WebGL layers (both projections — see
 * syncPlaneVisibility), so this matrix only covers the flat style layers.
 */
export function planeLayerVisibility(
	cluster: boolean,
	pitched: boolean,
): Record<string, boolean> {
	return {
		"flights-dots": !cluster && !pitched,
		"flights-notable": !pitched,
		"flight-trails": !cluster && !pitched,
		"cluster-circles": cluster && !pitched,
		"cluster-counts": cluster && !pitched,
		"cluster-planes": cluster && !pitched,
		"replay-trail-dots": !pitched,
		"replay-trail-notable": !pitched,
	};
}

const IDLE_LOOP_CLOCK: LoopClock = {
	anchorVirtual: 0,
	anchorWall: 0,
	speed: 10,
	scrubbing: false,
	paused: false,
};
const EMPTY_REPLAY_BUFFER: ReplayBuffer = new Map();

const NA_CENTER: [number, number] = [-98, 39];
const NA_ZOOM = 3;
// Camera pitch the 3D toggle eases to (issue #223); MapLibre's default maxPitch.
export const THREE_D_PITCH = 60;
// Pitch floor while 3D is ON: right-drag can tilt freely between these, but
// never flatten back into 2D — leaving 3D is the toggle's job. Comfortably
// above the 5° pitched threshold so the 3D layers can't flicker off mid-drag.
export const THREE_D_MIN_PITCH = 10;
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };
const FRAME_MS = 66; // ~15 fps animation gate
// Click hit-test slop (px). Dots are a small (3px) and gliding target, so an
// exact-pixel hit-test misses easily; a click within this radius selects the
// nearest dot instead of clearing the selection.
const HIT_TOLERANCE = 6;
// Replay-trail pins replay history under the live planes; the reduced opacity is the
// "this is not live" cue (replay-trails-under-live rendering).
const REPLAY_TRAIL_OPACITY = 0.4;
const REPLAY_TRAIL_STROKE_COLOR = "#ffffff";

export const FlightMap: FC<FlightMapProps> = ({
	ref: handleRef,
	positions, seedPositions, basemapUrls, trackGeoJSON,
	trackProfile = null, nowMs, playing,
	mapStyle, darkMap, pinColor, notablePinColor, observerPinColor, radarSweep, trailMultiplier,
	loopEnabled = false, loopWindowMs = 1_800_000,
	loopClock = IDLE_LOOP_CLOCK, replayBuffer = EMPTY_REPLAY_BUFFER,
	visibleFlights = null, landingClock,
	globe = false, threeD = false, terrain = false, cluster = false,
	selectMode = "off", onAreaSelect, onPitchedChange, aircraftFamilyOf,
	followFlight = null, cameraMode = "track",
	onSelectFlight, onClearSelection,
	pois = [], selectedPoiId = null, onSelectPoi,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const loadedRef = useRef(false);
	// Latest props read inside map event handlers registered once at create time.
	const positionsRef = useRef(positions);
	positionsRef.current = positions;
	const seedRef = useRef(seedPositions);
	seedRef.current = seedPositions;
	const poisRef = useRef(pois);
	poisRef.current = pois;
	const cbRef = useRef({
		onSelectFlight, onClearSelection, onAreaSelect, onPitchedChange, aircraftFamilyOf, onSelectPoi,
	});
	cbRef.current = {
		onSelectFlight, onClearSelection, onAreaSelect, onPitchedChange, aircraftFamilyOf, onSelectPoi,
	};
	// Families whose STL fetch has been kicked off (once per session).
	const requestedMeshesRef = useRef(new Set<string>());
	// 2D silhouettes: families whose SVG fetch has been kicked off, and the
	// resolved SVG text per family (kept so color changes can re-rasterize).
	const requestedIconFamiliesRef = useRef<Set<string>>(new Set());
	const loadedIconSvgsRef = useRef<Map<string, string>>(new Map());
	const selectModeRef = useRef<SelectMode>(selectMode);
	selectModeRef.current = selectMode;
	// In-flight drag state (mutated at event rate); the overlay div re-renders
	// through React state so the visual tracks the pointer.
	const dragRef = useRef<DragPixels | null>(null);
	const [overlay, setOverlay] = useState<{ mode: "rect" | "circle"; d: DragPixels } | null>(null);
	const colorsRef = useRef<FlightMapColors>({
		mapStyle, darkMap, pinColor, notablePinColor, observerPinColor, terrain,
	});
	colorsRef.current = { mapStyle, darkMap, pinColor, notablePinColor, observerPinColor, terrain };
	const radarSweepRef = useRef(radarSweep);
	radarSweepRef.current = radarSweep;
	const trailMultiplierRef = useRef(trailMultiplier);
	trailMultiplierRef.current = trailMultiplier;
	const globeRef = useRef(globe);
	globeRef.current = globe;
	const threeDRef = useRef(threeD);
	threeDRef.current = threeD;
	const clusterRef = useRef(cluster);
	clusterRef.current = cluster;
	const loopRef = useRef({
		enabled: loopEnabled, windowMs: loopWindowMs, clock: loopClock, buffer: replayBuffer,
		visible: visibleFlights,
	});
	loopRef.current = {
		enabled: loopEnabled, windowMs: loopWindowMs, clock: loopClock, buffer: replayBuffer,
		visible: visibleFlights,
	};
	// Camera follow: the rAF loop reads the current target/mode; followActiveRef
	// is the lock flag other effects check so they don't fight the driven camera.
	const followRef = useRef({ flight: followFlight, mode: cameraMode });
	followRef.current = { flight: followFlight, mode: cameraMode };
	const followActiveRef = useRef(false);

	useImperativeHandle(handleRef, () => ({
		zoomIn: () => {
			const map = mapRef.current;
			map?.easeTo({ zoom: map.getZoom() + 1, duration: 250 });
		},
		zoomOut: () => {
			const map = mapRef.current;
			map?.easeTo({ zoom: map.getZoom() - 1, duration: 250 });
		},
		flyTo: (center, zoom) => mapRef.current?.flyTo({ center, zoom, essential: true }),
		resetNorth: () => mapRef.current?.easeTo({ bearing: 0, duration: 400 }),
	}), []);

	const motionBufferRef = useRef<MotionBuffer>(new Map());
	// Landing/crash instants, read at frame rate by every motion builder.
	const landingRef = useRef<LandingClock | undefined>(landingClock);
	landingRef.current = landingClock;
	// Smooth virtual "now" as the rAF loop computes it — used by the pitched
	// hit tests so clicked positions match the gliding render exactly.
	const smoothNow = () => {
		const a = anchorRef.current;
		return playingRef.current ? a.virtual + (performance.now() - a.wall) : a.virtual;
	};
	// Screen positions of every airborne plane AT its rendered (glided)
	// altitude — the pitched replacement for queryRenderedFeatures, which only
	// tests fill-extrusion ground footprints.
	const planeScreenPositions = (map: maplibregl.Map) => {
		const now = smoothNow();
		const out: { flight: string; x: number; y: number }[] = [];
		for (const m of motionBufferRef.current.values()) {
			// Same landing clamp as the render, so clicks land on frozen planes.
			const effNow = motionNow(m, now, landingRef.current);
			const altFt = altitudeFtAt(m, effNow);
			if (altFt <= 0) continue;
			const head = extrapolate(m, effNow);
			const p = projectAtAltitude(map, head.lon, head.lat, exaggeratedHeightM(altFt));
			if (!p) continue; // behind the globe — not clickable
			out.push({ flight: m.item.flight, x: p.x, y: p.y });
		}
		return out;
	};
	const nowMsRef = useRef(nowMs);
	nowMsRef.current = nowMs;
	const playingRef = useRef(playing);
	playingRef.current = playing;
	// Smooth virtual clock anchor: virtual instant + the wall time it was set.
	const anchorRef = useRef({ virtual: nowMs, wall: 0 });
	// Whether a frame is owed while paused (buffer/clock changed since last draw).
	const dirtyRef = useRef(true);
	// Map bearing, mirrored into React state for the compass overlay.
	const [bearing, setBearing] = useState(0);
	// Whether the camera is meaningfully pitched (3D button OR manual
	// right-click). Altitude geometry renders only while pitched — flat
	// top-down maps keep the classic 2D look with zero extra draw cost.
	const pitchedRef = useRef(false);
	// The true-3D aircraft custom layer (issue #250); one instance per map.
	const planes3DRef = useRef<Planes3DLayer | null>(null);
	// Its replay-trail-sphere sibling (issue #242): same class, sphere mesh, translucent.
	const replayTrail3DRef = useRef<Planes3DLayer | null>(null);
	// The selected flight's smooth 3D track tube.
	const trackTubeRef = useRef<TrackTube3DLayer | null>(null);
	// Smooth live-trail ribbons (same class, translucent + flat-shaded).
	const trailTubeRef = useRef<TrackTube3DLayer | null>(null);
	// Alternating-frame gate for the ribbon rebuild (see the rAF loop).
	const trailFrameRef = useRef(false);
	const trackProfileRef = useRef<AltitudeSample[] | null>(trackProfile);
	trackProfileRef.current = trackProfile;
	// Apply the layer-visibility matrix AND the custom layers' draw gates from
	// one place, so the three flags can never drift apart across call sites.
	const syncPlaneVisibility = (map: maplibregl.Map) => {
		for (const [id, visible] of Object.entries(
			planeLayerVisibility(clusterRef.current, pitchedRef.current),
		)) {
			map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
		}
		// The custom layers render under BOTH projections — projectTileFor3D's
		// GLOBE branch handles the sphere (verified live 2026-07-15), so the
		// old extrusion fallbacks are gone.
		const custom3D = pitchedRef.current;
		planes3DRef.current?.setVisible(custom3D);
		replayTrail3DRef.current?.setVisible(custom3D);
		trackTubeRef.current?.setVisible(custom3D);
		trailTubeRef.current?.setVisible(custom3D && !clusterRef.current);
		// Pitched: the elevated geometry carries the track color, so the ground
		// line darkens into its shadow; flat: it IS the track, full color.
		map.setPaintProperty(
			"track-line",
			"line-color",
			pitchedRef.current ? TRACK_SHADOW_COLOR : TRACK_LINE_COLOR,
		);
	};

	// Create the map once (basemapUrls is effectively stable from env).
	useEffect(() => {
		if (!containerRef.current) return;
		ensurePmtilesProtocol();
		const map = new maplibregl.Map({
			container: containerRef.current,
			style: buildBasemapStyle(basemapUrls, colorsRef.current.mapStyle, colorsRef.current.darkMap),
			center: NA_CENTER,
			zoom: NA_ZOOM,
			attributionControl: false,
			// Pitch is exclusively the 3D toggle's domain: with 3D off the map is
			// hard-locked flat (right-drag still rotates bearing, never the z
			// axis); with 3D on it's confined to [THREE_D_MIN_PITCH, THREE_D_PITCH]
			// so dragging can't flatten back into 2D either. The threeD effect
			// moves both bounds on toggle.
			minPitch: threeDRef.current ? THREE_D_MIN_PITCH : 0,
			maxPitch: threeDRef.current ? THREE_D_PITCH : 0,
		});
		mapRef.current = map;

		map.on("load", () => {
			const colors = colorsRef.current;
			// Projection/pitch are style-coupled, so a persisted globe/3D setting
			// is seeded here rather than in the props effects (which skip pre-load).
			map.setProjection({ type: globeRef.current ? "globe" : "mercator" });
			if (threeDRef.current) map.jumpTo({ pitch: THREE_D_PITCH });
			updateMotion(motionBufferRef.current, positionsRef.current);
			if (seedRef.current?.length)
				seedMotionFromHistory(motionBufferRef.current, seedRef.current);
			const initialPointsFc = motionPointsToGeoJSON(
				motionBufferRef.current, nowMsRef.current, landingRef.current,
				(m: FlightMotion) => cbRef.current.aircraftFamilyOf?.(m.item.flight, m.item.start_date) ?? "generic",
			);
			map.addSource("flights", { type: "geojson", data: initialPointsFc });
			requestFamilyIcons(
				initialPointsFc, requestedIconFamiliesRef.current, loadedIconSvgsRef.current,
				mapRef, colorsRef,
			);
			map.addSource("track", { type: "geojson", data: EMPTY_FC });
			// lineMetrics enables the line-progress-based fade gradient on the trails.
			map.addSource("flight-trails", { type: "geojson", data: EMPTY_FC, lineMetrics: true });
			map.addLayer({
				id: "track-line", type: "line", source: "track",
				paint: { "line-color": TRACK_LINE_COLOR, "line-width": 2 },
			});
			// Breadcrumb trails under the dots, faded oldest→head by a line-gradient.
			map.addLayer({
				id: "flight-trails", type: "line", source: "flight-trails",
				paint: { "line-width": 1.2, "line-gradient": trailGradient(colors.mapStyle, colors.darkMap) },
			});
			map.addLayer({
				id: "flights-dots", type: "symbol", source: "flights",
				filter: ["all", ["!=", ["get", "notable"], true], ["!=", ["get", "observer"], true]],
				layout: {
					"icon-image": FAMILY_ICON_IMAGE,
					// Grow to 1.5× while zooming in, capping at ~zoom 9 — where a
					// typical viewport spans roughly 100 miles at CONUS latitudes
					// (interpolate clamps past the last stop). Notables stay fixed.
					"icon-size": ["interpolate", ["linear"], ["zoom"], 4, 1, 9, 1.5],
					"icon-rotate": ["-", ["get", "heading"], 90],
					"icon-rotation-alignment": "map",
					"icon-allow-overlap": true,
					"icon-ignore-placement": true,
				},
			});
			// Always-on highlight of the notable flights (renders nothing until the
			// notable-flights data story loads AA11/UA175/AA77/UA93) and observer
			// aircraft (GOFER06), which share the layer in their own color.
			map.addLayer({
				id: "flights-notable", type: "symbol", source: "flights",
				filter: ["any", ["==", ["get", "notable"], true], ["==", ["get", "observer"], true]],
				layout: {
					"icon-image": HIGHLIGHT_ICON_IMAGE,
					"icon-rotate": ["-", ["get", "heading"], 90],
					"icon-rotation-alignment": "map",
					"icon-allow-overlap": true,
					"icon-ignore-placement": true,
				},
			});
			void installPlaneIcons(
				map, colors.pinColor, colors.notablePinColor, colors.observerPinColor,
				pixelPlanes(colors.mapStyle),
			);
			// Cluster mode (issue #222): a second, pre-clustered source — MapLibre
			// fixes the cluster option at addSource time, so toggling is a
			// visibility swap between the plane/trail layers and these three.
			// Notables are excluded from the feed (nonNotableFeatures) and keep
			// rendering individually from the raw source above.
			const clusterVis = clusterRef.current ? ("visible" as const) : ("none" as const);
			map.addSource("flights-clustered", {
				type: "geojson", data: EMPTY_FC,
				cluster: true, clusterRadius: 40, clusterMaxZoom: 10,
			});
			map.addLayer({
				id: "cluster-circles", type: "circle", source: "flights-clustered",
				filter: ["has", "point_count"],
				layout: { visibility: clusterVis },
				paint: {
					"circle-color": colors.pinColor, "circle-opacity": 0.8,
					"circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff",
					"circle-radius": ["step", ["get", "point_count"], 10, 25, 14, 100, 18, 400, 24],
				},
			});
			map.addLayer({
				id: "cluster-counts", type: "symbol", source: "flights-clustered",
				filter: ["has", "point_count"],
				layout: {
					visibility: clusterVis,
					"text-field": "{point_count_abbreviated}",
					"text-font": ["Noto Sans Regular"],
					"text-size": 11,
					"text-allow-overlap": true,
				},
				paint: { "text-color": "#ffffff" },
			});
			map.addLayer({
				id: "cluster-planes", type: "symbol", source: "flights-clustered",
				filter: ["!", ["has", "point_count"]],
				layout: {
					visibility: clusterVis,
					"icon-image": FAMILY_ICON_IMAGE,
					"icon-size": ["interpolate", ["linear"], ["zoom"], 4, 1, 9, 1.5],
					"icon-rotate": ["-", ["get", "heading"], 90],
					"icon-rotation-alignment": "map",
					"icon-allow-overlap": true,
					"icon-ignore-placement": true,
				},
			});
			// All 3D geometry — aircraft, trail ribbons, replay-trail spheres,
			// the selected flight's track tube — renders through the custom
			// WebGL layers added below; MapLibre's fill-extrusion (flat tops,
			// no per-vertex elevation) is out of the 3D picture entirely.
			// Loop-mode replay trails render under BOTH live plane layers ("flights-dots"
			// is the lower of the two, so inserting before it puts replay trails under
			// both) but above the trails. They stay simple circles — visually
			// distinct from the live plane icons, and recolorable via paint (the
			// icons bake their color in). Not clickable: the hit-test below only
			// queries the live layers.
			map.addSource("replay-trails", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "replay-trail-dots", type: "circle", source: "replay-trails",
				paint: {
					"circle-radius": 3, "circle-color": colors.pinColor,
					"circle-opacity": REPLAY_TRAIL_OPACITY,
					"circle-stroke-width": 0.5, "circle-stroke-color": REPLAY_TRAIL_STROKE_COLOR,
					"circle-stroke-opacity": REPLAY_TRAIL_OPACITY,
				},
			}, "flights-dots");
			map.addLayer({
				id: "replay-trail-notable", type: "circle", source: "replay-trails",
				filter: ["any", ["==", ["get", "notable"], true], ["==", ["get", "observer"], true]],
				paint: {
					"circle-radius": 5,
					"circle-color": highlightTrailColor(colors.notablePinColor, colors.observerPinColor),
					"circle-opacity": REPLAY_TRAIL_OPACITY,
					"circle-stroke-width": 1, "circle-stroke-color": REPLAY_TRAIL_STROKE_COLOR,
					"circle-stroke-opacity": REPLAY_TRAIL_OPACITY,
				},
			}, "flights-dots");
			// Radar sweep + afterglow wedge, under the track line and all flight
			// layers. Color = Classicy theme var, resolved from the DOM because
			// WebGL paint can't read CSS custom properties.
			map.addSource("radar-sweep", {
				type: "geojson", data: sweepLineGeoJSON(nowMsRef.current),
			});
			map.addSource("radar-trail", {
				type: "geojson", data: sweepTrailGeoJSON(nowMsRef.current),
			});
			const radarColor = resolveCssColor(
				containerRef.current ?? document.documentElement,
				"--color-system-04",
				RADAR_FALLBACK_COLOR,
			);
			const radarVisibility = radarSweepRef.current ? "visible" : "none";
			map.addLayer({
				id: "radar-trail", type: "fill", source: "radar-trail",
				layout: { visibility: radarVisibility },
				paint: { "fill-color": radarColor, "fill-opacity": ["get", "opacity"] },
			}, "track-line");
			map.addLayer({
				id: "radar-sweep", type: "line", source: "radar-sweep",
				layout: { visibility: radarVisibility },
				paint: { "line-color": radarColor, "line-width": 1.5, "line-opacity": 0.8 },
			}, "track-line");
			// POI markers (ground-level; visible in EVERY pitch/cluster mode, so
			// deliberately NOT part of planeLayerVisibility). Clustered like flights.
			map.addSource("map-pois", {
				type: "geojson", data: poisToGeoJSON(poisRef.current),
				cluster: true, clusterRadius: 44, clusterMaxZoom: 9,
				promoteId: "id",
			});
			map.addLayer({
				id: "poi-clusters", type: "circle", source: "map-pois",
				filter: ["has", "point_count"],
				paint: {
					"circle-color": colors.pinColor, "circle-opacity": 0.75,
					"circle-stroke-width": 1.5, "circle-stroke-color": "#ffffff",
					"circle-radius": ["step", ["get", "point_count"], 10, 25, 14, 100, 18, 400, 24],
				},
			});
			map.addLayer({
				id: "poi-cluster-counts", type: "symbol", source: "map-pois",
				filter: ["has", "point_count"],
				layout: {
					"text-field": "{point_count_abbreviated}",
					"text-font": ["Noto Sans Regular"], "text-size": 11,
					"text-allow-overlap": true,
				},
				paint: { "text-color": "#ffffff" },
			});
			map.addLayer({
				id: "poi-pins", type: "symbol", source: "map-pois",
				filter: ["!", ["has", "point_count"]],
				layout: {
					"icon-image": POI_PIN_ICON_ID,
					"icon-anchor": "bottom",
					"icon-allow-overlap": true,
					"icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 8, 1],
					"text-field": ["get", "iata"],
					"text-font": ["Noto Sans Regular"], "text-size": 10,
					"text-offset": [0, 0.4], "text-anchor": "top",
					"text-allow-overlap": false, "text-optional": true,
				},
				paint: { "text-color": colors.pinColor, "text-halo-color": "#ffffff", "text-halo-width": 1 },
			});
			// Selected POI drawn 25% larger on its own single-feature source, ALWAYS
			// on top — so the chosen airport pops out even from inside a cluster.
			map.addSource("map-poi-selected", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "map-poi-selected", type: "symbol", source: "map-poi-selected",
				layout: {
					"icon-image": POI_PIN_ICON_ID, "icon-anchor": "bottom",
					"icon-allow-overlap": true, "icon-ignore-placement": true,
					"icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.7 * POI_SELECTED_SCALE, 8, POI_SELECTED_SCALE],
				},
			});
			void installPoiIcon(map, colors.pinColor, pixelPlanes(colors.mapStyle));
			applyMapColors(map, colorsRef.current);
			// Projection/pitch-style load-time seed for the terrain mesh: the
			// [terrain] effect below skips pre-load renders.
			if (colorsRef.current.terrain)
				map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: ALT_EXAGGERATION });
			// Now that every layer exists, resolve the pitch × cluster visibility
			// matrix ONCE from the actual camera. The jumpTo pitch seed above
			// fires "pitch" BEFORE the layers are added (its handler skips layer
			// writes while loadedRef is false — flipped only here, at the very
			// end), so a 3D-restored session must not depend on that event: this
			// is what hides the 2D pins after a refresh with 3D persisted on.
			// True-3D aircraft (issue #250): custom layer on top of the stack;
			// its colors follow the pin pair like every other plane layer.
			const planes3D = new Planes3DLayer();
			planes3D.setColors(colors.pinColor, colors.notablePinColor, colors.observerPinColor);
			planes3D.setPixelate(pixelPlanes(colors.mapStyle));
			planes3DRef.current = planes3D;
			map.addLayer(planes3D);
			// Loop-mode replay-trail spheres (issue #242): same instanced-mesh layer with
			// a sphere mesh at the 2D replay trails' opacity. Added after the aircraft —
			// translucent geometry must draw after the opaque planes it blends over.
			const replayTrail3D = new Planes3DLayer({
				id: "replay-trails-3d-model",
				buildMesh: () => buildSphereMesh(),
				opacity: REPLAY_TRAIL_OPACITY,
			});
			replayTrail3D.setColors(colors.pinColor, colors.notablePinColor, colors.observerPinColor);
			replayTrail3D.setPixelate(pixelPlanes(colors.mapStyle));
			replayTrail3DRef.current = replayTrail3D;
			map.addLayer(replayTrail3D);
			// Smooth 3D track tube: splined selected-flight path with per-vertex
			// elevation (the curtain staircases; it stays as the globe fallback).
			const trackTube = new TrackTube3DLayer();
			trackTube.setColor(TRACK_LINE_COLOR);
			trackTube.setGeometry(buildTrackTube(trackProfileRef.current));
			trackTubeRef.current = trackTube;
			map.addLayer(trackTube);
			// Smooth live-trail ribbons: splined breadcrumbs with per-vertex
			// elevation, replacing the chunky fill-extrusion slabs. Translucent
			// and flat-shaded like the 2D trail lines they mirror.
			const trailTube = new TrackTube3DLayer({
				id: "trails-3d-model", opacity: 0.45, shaded: false,
			});
			trailTube.setColor(trailColor(colors.mapStyle, colors.darkMap));
			trailTubeRef.current = trailTube;
			map.addLayer(trailTube);
			pitchedRef.current = map.getPitch() > 5;
			syncPlaneVisibility(map);
			loadedRef.current = true;
			dirtyRef.current = true;
		});

		// Forgiving hit-test: query a small box around the click and select the
		// NEAREST dot within it; clear the selection only when nothing is nearby.
		// (An exact-pixel layer click missed too often on the tiny gliding dots.)
		// Area-select drag (issue #225). MapLibre still emits mouse events with
		// dragPan disabled; the release queries the box and refines per-shape.
		map.on("mousedown", (e) => {
			if (selectModeRef.current === "off") return;
			dragRef.current = {
				startX: e.point.x, startY: e.point.y, curX: e.point.x, curY: e.point.y,
			};
		});
		map.on("mousemove", (e) => {
			const d = dragRef.current;
			const mode = selectModeRef.current;
			if (!d || mode === "off") return;
			d.curX = e.point.x;
			d.curY = e.point.y;
			setOverlay({ mode, d: { ...d } });
		});
		map.on("mouseup", (e) => {
			const d = dragRef.current;
			const mode = selectModeRef.current;
			dragRef.current = null;
			setOverlay(null);
			if (!d || mode === "off") return;
			d.curX = e.point.x;
			d.curY = e.point.y;
			const flights: string[] = [];
			if (pitchedRef.current) {
				// Pitched: test the planes' elevated screen positions directly
				// (fill-extrusion footprints sit far from the visible aircraft).
				for (const p of planeScreenPositions(map)) {
					if (!insideSelection(mode, d, p.x, p.y)) continue;
					if (!flights.includes(p.flight)) flights.push(p.flight);
				}
			} else {
				const b = dragBounds(mode, d);
				const feats = map.queryRenderedFeatures(
					[[b.minX, b.minY], [b.maxX, b.maxY]],
					{ layers: ["flights-dots", "flights-notable", "cluster-planes"] },
				);
				for (const f of feats) {
					const anchor = featureAnchor(f);
					if (!anchor) continue;
					const pp = map.project(anchor);
					if (!insideSelection(mode, d, pp.x, pp.y)) continue;
					const flight = String(f.properties?.flight ?? "");
					if (flight && !flights.includes(flight)) flights.push(flight);
				}
			}
			cbRef.current.onAreaSelect?.(flights);
		});

		map.on("click", (e) => {
			// While a select tool is armed, the drag handlers own the pointer.
			if (selectModeRef.current !== "off") return;
			const { x, y } = e.point;
			// Pitched: hit-test against the planes' ELEVATED screen positions.
			// queryRenderedFeatures only sees fill-extrusion ground footprints,
			// which sit far below the visible aircraft at cruise altitudes.
			if (pitchedRef.current) {
				// POIs first (ground-level; works in flat and pitched modes). A POI
				// cluster or pin within HIT_TOLERANCE takes precedence over flights and
				// returns here; otherwise fall through to flight hit-testing.
				const poiHits = map.queryRenderedFeatures(
					[[x - HIT_TOLERANCE, y - HIT_TOLERANCE], [x + HIT_TOLERANCE, y + HIT_TOLERANCE]],
					{ layers: ["poi-pins", "poi-clusters"] },
				);
				const poiCluster = poiHits.find((f) => f.properties?.cluster === true);
				if (poiCluster && poiCluster.geometry.type === "Point") {
					const src = map.getSource("map-pois") as maplibregl.GeoJSONSource | undefined;
					const center = poiCluster.geometry.coordinates as [number, number];
					void src
						?.getClusterExpansionZoom(Number(poiCluster.properties?.cluster_id))
						.then((zoom) => map.easeTo({ center, zoom }))
						.catch(() => {});
					return;
				}
				const poiPin = poiHits.find((f) => f.properties?.cluster !== true);
				if (poiPin) {
					const id = Number(poiPin.properties?.id);
					const hit = poisRef.current.find((p) => p.id === id);
					if (hit) { cbRef.current.onSelectPoi?.(hit); return; }
				}
				const tolerance = plane3DTargetPx(map.getZoom()) / 2 + HIT_TOLERANCE;
				let bestFlight: string | null = null;
				let bestDist = tolerance * tolerance;
				for (const p of planeScreenPositions(map)) {
					const d = (p.x - x) ** 2 + (p.y - y) ** 2;
					if (d < bestDist) {
						bestDist = d;
						bestFlight = p.flight;
					}
				}
				if (bestFlight) cbRef.current.onSelectFlight(bestFlight);
				else cbRef.current.onClearSelection();
				return;
			}
			// POIs first (ground-level; works in flat and pitched modes). A POI
			// cluster or pin within HIT_TOLERANCE takes precedence over flights and
			// returns here; otherwise fall through to flight hit-testing.
			const poiHits = map.queryRenderedFeatures(
				[[x - HIT_TOLERANCE, y - HIT_TOLERANCE], [x + HIT_TOLERANCE, y + HIT_TOLERANCE]],
				{ layers: ["poi-pins", "poi-clusters"] },
			);
			const poiCluster = poiHits.find((f) => f.properties?.cluster === true);
			if (poiCluster && poiCluster.geometry.type === "Point") {
				const src = map.getSource("map-pois") as maplibregl.GeoJSONSource | undefined;
				const center = poiCluster.geometry.coordinates as [number, number];
				void src
					?.getClusterExpansionZoom(Number(poiCluster.properties?.cluster_id))
					.then((zoom) => map.easeTo({ center, zoom }))
					.catch(() => {});
				return;
			}
			const poiPin = poiHits.find((f) => f.properties?.cluster !== true);
			if (poiPin) {
				const id = Number(poiPin.properties?.id);
				const hit = poisRef.current.find((p) => p.id === id);
				if (hit) { cbRef.current.onSelectPoi?.(hit); return; }
			}
			const near = map.queryRenderedFeatures(
				[
					[x - HIT_TOLERANCE, y - HIT_TOLERANCE],
					[x + HIT_TOLERANCE, y + HIT_TOLERANCE],
				],
				{
					layers: ["flights-dots", "flights-notable", "cluster-planes", "cluster-circles"],
				},
			);
			// A cluster blob expands instead of selecting.
			const clusterHit = near.find((f) => f.properties?.cluster === true);
			if (clusterHit && clusterHit.geometry.type === "Point") {
				const src = map.getSource("flights-clustered") as maplibregl.GeoJSONSource | undefined;
				const center = clusterHit.geometry.coordinates as [number, number];
				void src
					?.getClusterExpansionZoom(Number(clusterHit.properties?.cluster_id))
					.then((zoom) => map.easeTo({ center, zoom }))
					.catch(() => {});
				return;
			}
			if (near.length === 0) {
				cbRef.current.onClearSelection();
				return;
			}
			let best = near[0];
			let bestDist = Number.POSITIVE_INFINITY;
			for (const f of near) {
				const anchor = featureAnchor(f);
				if (!anchor) continue;
				const pp = map.project(anchor);
				const d = (pp.x - x) ** 2 + (pp.y - y) ** 2;
				if (d < bestDist) {
					bestDist = d;
					best = f;
				}
			}
			if (best.properties) cbRef.current.onSelectFlight(String(best.properties.flight));
		});

		map.on("rotate", () => setBearing(map.getBearing()));
		// Altitude layers key off the ACTUAL pitch so both the 3D toggle and a
		// manual right-click pitch reveal them.
		map.on("pitch", () => {
			const on = map.getPitch() > 5;
			if (on === pitchedRef.current) return;
			pitchedRef.current = on;
			if (loadedRef.current) syncPlaneVisibility(map);
			dirtyRef.current = true;
			// While following, pitch is camera-driven (not a manual right-drag), so
			// it must not flip the persisted 3D toggle — only report real user tilts.
			if (!followActiveRef.current) cbRef.current.onPitchedChange?.(on);
		});
		// Plane-slab size tracks the zoom (constant on-screen size); wake a
		// paused map so a zoom while paused re-sizes the 3D planes.
		map.on("zoom", () => {
			if (pitchedRef.current) dirtyRef.current = true;
		});

		const ro = new ResizeObserver(() => map.resize());
		ro.observe(containerRef.current);

		return () => {
			ro.disconnect();
			map.remove(); // also fires the custom layers' onRemove (GL teardown)
			planes3DRef.current = null;
			replayTrail3DRef.current = null;
			trackTubeRef.current = null;
			trailTubeRef.current = null;
			mapRef.current = null;
			loadedRef.current = false;
		};
	}, [basemapUrls]);

	// Fold each new airborne snapshot into the motion buffer, then re-apply the
	// heading seed: chunks can land before OR after the snapshot that creates
	// the buffer entries they refine, and seeding is idempotent either way.
	useEffect(() => {
		updateMotion(motionBufferRef.current, positions);
		if (seedPositions?.length)
			seedMotionFromHistory(motionBufferRef.current, seedPositions);
		dirtyRef.current = true;
	}, [positions, seedPositions]);

	// Re-anchor the smooth clock on each coarse provider tick / play-state change.
	useEffect(() => {
		anchorRef.current = { virtual: nowMs, wall: performance.now() };
		dirtyRef.current = true;
	}, [nowMs]);
	useEffect(() => {
		dirtyRef.current = true;
	}, [playing]);

	// Push the selected track (or clear it).
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const src = map.getSource("track") as maplibregl.GeoJSONSource | undefined;
		src?.setData(trackGeoJSON ? { type: "FeatureCollection", features: [trackGeoJSON] } : EMPTY_FC);
	}, [trackGeoJSON]);

	// Re-feed the clustered POI source when the enabled set changes (layer toggles).
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const src = map.getSource("map-pois") as maplibregl.GeoJSONSource | undefined;
		src?.setData(poisToGeoJSON(pois));
		dirtyRef.current = true;
	}, [pois]);

	// Feed the selected-pin overlay with just the selected POI (or clear it).
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const src = map.getSource("map-poi-selected") as maplibregl.GeoJSONSource | undefined;
		const sel = pois.find((p) => p.id === selectedPoiId) ?? null;
		src?.setData(sel ? poisToGeoJSON([sel]) : EMPTY_FC);
		dirtyRef.current = true;
	}, [pois, selectedPoiId]);

	// Rebuild the smooth track tube when the selection's profile changes; an
	// empty/null profile clears it. Radius comes per-frame from the rAF loop.
	useEffect(() => {
		if (!mapRef.current || !loadedRef.current) return;
		trackTubeRef.current?.setGeometry(buildTrackTube(trackProfile));
		dirtyRef.current = true;
	}, [trackProfile]);

	// Re-theme / recolor live. setPaintProperty only — setStyle() would tear
	// down the flights/trails/track sources and layers. Before "load" fires,
	// the load handler's applyMapColors call picks up the latest values.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		applyMapColors(map, { mapStyle, darkMap, pinColor, notablePinColor, observerPinColor, terrain });
		// mapStyle is already a dep, so switching to/from radar re-rasterizes
		// every registered icon into (or out of) its 8-bit variant for free.
		const pixelate = pixelPlanes(mapStyle);
		void installPlaneIcons(map, pinColor, notablePinColor, observerPinColor, pixelate);
		for (const [family, svg] of loadedIconSvgsRef.current) {
			void installFamilyIcon(
				map, family, svg, pinColor, notablePinColor, observerPinColor, pixelate,
			);
		}
		void installPoiIcon(map, pinColor, pixelate);
		if (map.getLayer("poi-pins")) map.setPaintProperty("poi-pins", "text-color", pinColor);
		planes3DRef.current?.setColors(pinColor, notablePinColor, observerPinColor);
		replayTrail3DRef.current?.setColors(pinColor, notablePinColor, observerPinColor);
		// The 3D meshes get the same radar 8-bit treatment as the 2D icons, via a
		// low-res render pass rather than a re-rasterize (see Planes3DLayer).
		planes3DRef.current?.setPixelate(pixelate);
		replayTrail3DRef.current?.setPixelate(pixelate);
		trailTubeRef.current?.setColor(trailColor(mapStyle, darkMap));
	}, [mapStyle, darkMap, pinColor, notablePinColor, observerPinColor, terrain]);

	// Arm/disarm the select tool: panning off, crosshair cursor, stale drag
	// cleared. Runs pre-load safely (dragPan exists from construction).
	useEffect(() => {
		const map = mapRef.current;
		if (!map) return;
		// The follow lock owns pan while active; it re-applies the select-tool
		// state on release, so don't let a selectMode change re-enable pan here.
		if (followActiveRef.current) return;
		if (selectMode !== "off") {
			map.dragPan.disable();
			map.getCanvas().style.cursor = "crosshair";
		} else {
			map.dragPan.enable();
			map.getCanvas().style.cursor = "";
			dragRef.current = null;
			setOverlay(null);
		}
	}, [selectMode]);

	// Cluster toggle: resolve the full pitch × cluster visibility matrix; the
	// rAF loop feeds whichever sources are active.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		syncPlaneVisibility(map);
		dirtyRef.current = true;
	}, [cluster]);

	// Mercator ↔ globe. Projection survives style-paint changes, so this only
	// needs to run on the toggle itself (plus the load-time seed above). The
	// pitched-aircraft render path swaps with it (custom layer ↔ extrusion
	// fallback), so the visibility matrix re-resolves too.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		map.setProjection({ type: globe ? "globe" : "mercator" });
		syncPlaneVisibility(map);
		dirtyRef.current = true;
	}, [globe]);

	// 3D mode gates pitch entirely: ON confines the camera to
	// [THREE_D_MIN_PITCH, THREE_D_PITCH] (right-drag tilts within the band but
	// can't flatten back to 2D) and eases to the preset; OFF collapses the band
	// to exactly 0, which snaps the camera flat and makes right-drag
	// bearing-only. Order matters both ways: MapLibre rejects min > max, so
	// max lifts before min on enable and min drops before max on disable.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		// The follow lock owns the pitch band while active (cockpit needs more
		// than THREE_D_PITCH); it re-applies these constraints from threeDRef on
		// release, so skip here to avoid clamping the driven pitch.
		if (followActiveRef.current) return;
		if (threeD) {
			map.setMaxPitch(THREE_D_PITCH);
			map.setMinPitch(THREE_D_MIN_PITCH);
			map.easeTo({ pitch: THREE_D_PITCH, duration: 600 });
		} else {
			map.setMinPitch(0);
			map.setMaxPitch(0);
		}
	}, [threeD]);

	// Terrain mesh on/off. The hillshade half of the toggle rides the re-theme
	// effect above (applyMapColors); this owns only the ground mesh.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		// Terrain shares the aircraft altitude exaggeration so mountains stay in
		// proportion to the rendered flights. Safe against burial: a plane's MSL
		// altitude is always ≥ the ground's, so scaling both by the same factor
		// keeps every plane above the mesh.
		map.setTerrain(terrain ? { source: TERRAIN_SOURCE, exaggeration: ALT_EXAGGERATION } : null);
		dirtyRef.current = true;
	}, [terrain]);

	// Camera follow lock (tracked flights): entering disables user camera control
	// and opens the pitch band so the rAF loop can drive any framing; leaving
	// re-enables control (honoring an armed select tool) and restores the 2D/3D
	// pitch constraints. The per-frame camera drive lives in the rAF loop below.
	useEffect(() => {
		// dragPan / pitch APIs exist from construction (no layers needed), so this
		// runs pre-load safely — a follow set before "load" still locks the camera.
		const map = mapRef.current;
		if (!map) return;
		const active = followFlight != null;
		if (active === followActiveRef.current) return;
		followActiveRef.current = active;
		if (active) {
			setCameraInteractive(map, false);
			map.setMinPitch(0);
			map.setMaxPitch(MAX_FOLLOW_PITCH);
		} else {
			setCameraInteractive(map, true);
			// A select tool armed during follow (shouldn't happen — it's disabled in
			// the toolbar — but be safe) keeps pan off and the crosshair cursor.
			if (selectModeRef.current !== "off") {
				map.dragPan.disable();
				map.getCanvas().style.cursor = "crosshair";
			}
			restorePitchConstraints(map, threeDRef.current);
		}
		dirtyRef.current = true;
	}, [followFlight]);

	// Show/hide the radar sweep. On re-enable, re-resolve the theme color so an
	// Appearance-theme switch that happened while hidden is picked up. dirtyRef
	// makes a paused map redraw once so the change is visible immediately.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const vis = radarSweep ? "visible" : "none";
		map.setLayoutProperty("radar-sweep", "visibility", vis);
		map.setLayoutProperty("radar-trail", "visibility", vis);
		if (radarSweep) {
			const c = resolveCssColor(
				containerRef.current ?? document.documentElement,
				"--color-system-04",
				RADAR_FALLBACK_COLOR,
			);
			map.setPaintProperty("radar-sweep", "line-color", c);
			map.setPaintProperty("radar-trail", "fill-color", c);
		}
		dirtyRef.current = true;
	}, [radarSweep]);

	// New trail length applies next frame; wake a paused map for one redraw.
	useEffect(() => {
		dirtyRef.current = true;
	}, [trailMultiplier]);

	// Entering/leaving loop mode: clear the replay-trail layer when leaving so stale
	// replay trails don't linger under a paused map; dirtyRef redraws once either way.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		if (!loopEnabled) {
			(map.getSource("replay-trails") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
			replayTrail3DRef.current?.updateInstances(new Float32Array(0), 0);
		}
		dirtyRef.current = true;
	}, [loopEnabled]);

	// Glide dots + draw trails at ~15 fps off a smooth virtual clock. While
	// playing, advance wall-time deltas from the anchor (RATE 1×); while paused,
	// hold at the anchor and idle after the last draw. All virtual/UTC ms.
	useEffect(() => {
		let lastRender = 0;
		const loop = (wall: number) => {
			raf = requestAnimationFrame(loop);
			const map = mapRef.current;
			if (!map || !loadedRef.current) return;
			if (wall - lastRender < FRAME_MS) return;
			// Loop mode animates even while the virtual clock is paused: the live
			// edge freezes but the loop keeps cycling through the frozen window.
			if (!playingRef.current && !dirtyRef.current && !loopRef.current.enabled) {
				lastRender = wall;
				return;
			}
			lastRender = wall;
			dirtyRef.current = false;
			const a = anchorRef.current;
			const now = playingRef.current ? a.virtual + (wall - a.wall) : a.virtual;
			const buf = motionBufferRef.current;
			const landing = landingRef.current;
			// Camera follow: lock onto the followed flight's live (glided) position,
			// heading-driven framing per mode. jumpTo (not easeTo) so it tracks the
			// dot frame-for-frame instead of chasing an animation. Its pitch change
			// flows through the "pitch" handler → 3D geometry arms for cockpit/highlight.
			const follow = followRef.current;
			if (follow.flight) {
				const fm = buf.get(follow.flight);
				if (fm) {
					const head = extrapolate(fm, motionNow(fm, now, landing));
					map.jumpTo(
						cameraPose(
							follow.mode,
							{ lon: head.lon, lat: head.lat, headingDeg: fm.headingDeg },
							map.getZoom(),
						),
					);
				}
			}
			const pointsFc = motionPointsToGeoJSON(
				buf, now, landing,
				(m: FlightMotion) => cbRef.current.aircraftFamilyOf?.(m.item.flight, m.item.start_date) ?? "generic",
			);
			requestFamilyIcons(
				pointsFc, requestedIconFamiliesRef.current, loadedIconSvgsRef.current,
				mapRef, colorsRef,
			);
			(map.getSource("flights") as maplibregl.GeoJSONSource | undefined)?.setData(pointsFc);
			if (clusterRef.current) {
				(map.getSource("flights-clustered") as maplibregl.GeoJSONSource | undefined)?.setData(
					nonNotableFeatures(pointsFc),
				);
			}
			if (pitchedRef.current) {
				const zoom = map.getZoom();
				const sizeKm = plane3DTargetPx(zoom) * kmPerPixel(zoom, map.getCenter().lat);
				// Track-tube thickness tracks the marker scale (half the trail
				// ribbons' 0.08 width factor); radius is a uniform, so this is free.
				trackTubeRef.current?.setRadius(sizeKm * 1000 * 0.04);
				if (planes3DRef.current) {
					// Per-airframe batches (issue #250 follow-up): each family
					// draws its own model; unloaded families render the prism
					// until their STL arrives, and every family seen kicks off
					// its (cached, immutable) asset fetch.
					const layer = planes3DRef.current;
					const batches = buildPlaneInstanceBatches(
						buf, now, sizeKm,
						(m) => cbRef.current.aircraftFamilyOf?.(m.item.flight, m.item.start_date) ?? "default",
						landing,
					);
					for (const b of batches) {
						if (b.meshKey !== "default" && !requestedMeshesRef.current.has(b.meshKey)) {
							requestedMeshesRef.current.add(b.meshKey);
							void loadAircraftMesh(b.meshKey as AircraftFamily).then((mesh) => {
								if (mesh) layer.registerMesh(b.meshKey, mesh);
							});
						}
					}
					layer.updateBatches(batches);
					map.triggerRepaint();
				}
			}
			// Clamp: hand-edited persisted state must not build million-point trails.
			const clamped = Math.min(Math.max(trailMultiplierRef.current, 0), TRAIL_MULTIPLIER_MAX);
			const trailPoints = Math.round(TRAIL_POINTS * clamped);
			if (pitchedRef.current) {
				// Floating splined ribbons replace the ground lines while pitched;
				// width tracks the plane-marker scale via the radius uniform.
				// Ribbons rebuild every SECOND pass (~7.5 fps): they're wide soft
				// shapes whose per-frame delta is subpixel, and their geometry is
				// the heaviest per-frame build with thousands aloft.
				trailFrameRef.current = !trailFrameRef.current;
				const zoomT = map.getZoom();
				const sizeKmT = plane3DTargetPx(zoomT) * kmPerPixel(zoomT, map.getCenter().lat);
				if (trailTubeRef.current && trailFrameRef.current) {
					trailTubeRef.current.setRadius(sizeKmT * 1000 * 0.04); // half-width
					trailTubeRef.current.setGeometry(buildTrailTubes(buf, now, {
						displayPoints: trailPoints,
						// Subdivision only where corners are visible on screen.
						steps: zoomT <= 5 ? 1 : zoomT <= 7 ? 2 : 3,
						// Stop the ribbon at the tail: the 3D models span ±0.9 of
						// the half-size along their length.
						headOffsetM: sizeKmT * 450,
						landing,
					}));
					map.triggerRepaint();
				}
			} else {
				(map.getSource("flight-trails") as maplibregl.GeoJSONSource | undefined)?.setData(
					motionTrailsToGeoJSON(buf, now, trailPoints, landing),
				);
			}
			if (radarSweepRef.current) {
				(map.getSource("radar-sweep") as maplibregl.GeoJSONSource | undefined)?.setData(
					sweepLineGeoJSON(now),
				);
				(map.getSource("radar-trail") as maplibregl.GeoJSONSource | undefined)?.setData(
					sweepTrailGeoJSON(now),
				);
			}
			const loopState = loopRef.current;
			if (loopState.enabled) {
				const playhead = playheadAt(
					loopState.clock, wall, now - loopState.windowMs, now,
				);
				if (pitchedRef.current) {
					const zoomG = map.getZoom();
					const replayTrailRadiusKm =
						plane3DTargetPx(zoomG) * kmPerPixel(zoomG, map.getCenter().lat) * 0.12;
					if (replayTrail3DRef.current) {
						const inst = buildReplayTrailInstances(
							loopState.buffer, playhead, loopState.visible, replayTrailRadiusKm,
						);
						replayTrail3DRef.current.updateInstances(inst.data, inst.count);
						map.triggerRepaint();
					}
				} else {
					(map.getSource("replay-trails") as maplibregl.GeoJSONSource | undefined)?.setData(
						replayPointsAt(loopState.buffer, playhead, loopState.visible),
					);
				}
			}
		};
		let raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, []);

	return (
		<div
			style={{
				position: "relative",
				width: "100%",
				height: "100%",
				// In globe projection the canvas is transparent around the planet;
				// match that "space" to the style's ground tone instead of the
				// window's white body.
				background: basemapPalette(mapStyle, darkMap).background,
			}}
		>
			<div ref={containerRef} style={{ width: "100%", height: "100%" }} />
			<MapCompass
				bearing={bearing}
				onReset={() => mapRef.current?.easeTo({ bearing: 0, duration: 400 })}
			/>
			{overlay && (
				<div className={styles.selectOverlay} style={overlayStyle(overlay.mode, overlay.d)} />
			)}
		</div>
	);
};
