import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { type FC, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MapCompass } from "./MapCompass";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightFeatureCollection } from "./flightGeoJSON";
import { basemapPalette } from "../../lib/basemap/basemapStyles";
import {
	type BasemapStyleId,
	type BasemapUrls,
	TRACK_LINE_COLOR,
	applyMapColors,
	buildBasemapStyle,
	type FlightMapColors,
	trailColor,
	trailGradient,
} from "./flightMapStyle";
import planeSvg from "./plane.svg?raw";
import {
	PLANE_ICON_ID,
	PLANE_ICON_PX,
	PLANE_NOTABLE_ICON_ID,
	PLANE_NOTABLE_ICON_PX,
	buildPlaneImage,
} from "./flightIcons";
import {
	type MotionBuffer,
	TRAIL_MULTIPLIER_MAX,
	TRAIL_POINTS,
	extrapolate,
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
	altitudeFtAt,
	exaggeratedHeightM,
	kmPerPixel,
	motionPlanes3DToGeoJSON,
	motionTrails3DToGeoJSON,
	plane3DTargetPx,
} from "./flightAltitude";
import {
	type DragPixels,
	type SelectMode,
	dragBounds,
	insideSelection,
	overlayStyle,
} from "./selectTool";
import styles from "./FlightTracker.module.scss";
import { type ReplayBuffer, replayGhosts3DAt, replayPointsAt } from "./flightReplay";
import { type LoopClock, playheadAt } from "./loopClock";

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
) {
	try {
		const [regular, notable] = await Promise.all([
			buildPlaneImage(planeSvg, pinColor, PLANE_ICON_PX),
			buildPlaneImage(planeSvg, notablePinColor, PLANE_NOTABLE_ICON_PX),
		]);
		if (map.hasImage(PLANE_ICON_ID)) map.updateImage(PLANE_ICON_ID, regular);
		else map.addImage(PLANE_ICON_ID, regular, { pixelRatio: 2 });
		if (map.hasImage(PLANE_NOTABLE_ICON_ID)) map.updateImage(PLANE_NOTABLE_ICON_ID, notable);
		else map.addImage(PLANE_NOTABLE_ICON_ID, notable, { pixelRatio: 2 });
	} catch (err) {
		console.warn("plane icons unavailable:", err);
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
	// Curtain wall under the selected flight's path (issue #224): pre-built
	// extrusion quads from its altitude profile; renders only while pitched.
	curtainGeoJSON?: GeoJSON.FeatureCollection | null;
	nowMs: number;
	playing: boolean;
	mapStyle: BasemapStyleId;
	darkMap: boolean;
	// CSS hex strings — FlightTracker converts from the persisted packed ints.
	pinColor: string;
	notablePinColor: string;
	radarSweep: boolean;
	// Comet-tail length as a multiple of TRAIL_POINTS; 0 turns tails off.
	trailMultiplier: number;
	// Loop mode (optional with idle defaults so non-loop call sites stay simple):
	// while enabled, ghost pins replay replayBuffer at the loopClock's playhead,
	// wrapped into the sliding [now − loopWindowMs, now) window.
	loopEnabled?: boolean;
	loopWindowMs?: number;
	loopClock?: LoopClock;
	replayBuffer?: ReplayBuffer;
	// Filter Flights (issue #188): ghosts of flights outside this set are
	// skipped at draw time; null/omitted shows all. Live pins are filtered
	// upstream by FlightTracker via the positions array itself.
	visibleFlights?: Set<string> | null;
	// MapControls toggles (issues #218/#222/#223); persisted in FlightMapSettings.
	globe?: boolean;
	threeD?: boolean;
	cluster?: boolean;
	// Area-select tool (issue #225): while armed, drags trace a rectangle or
	// circle instead of panning; the release reports the flights inside.
	selectMode?: SelectMode;
	onAreaSelect?: (flights: string[]) => void;
	// Fires when the camera crosses the pitched threshold in either direction —
	// FlightTracker keeps the 3D toggle in sync with manual z-axis drags.
	onPitchedChange?: (pitched: boolean) => void;
	onSelectFlight: (flight: string) => void;
	onClearSelection: () => void;
}

/** Non-notable features only — notables never cluster (issue #222). */
export function nonNotableFeatures(fc: FlightFeatureCollection): FlightFeatureCollection {
	return {
		type: "FeatureCollection",
		features: fc.features.filter((f) => f.properties.notable !== true),
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

// Screen position of a location AT ALTITUDE. queryRenderedFeatures on
// fill-extrusion layers hit-tests the ground FOOTPRINT, not the visually
// elevated pixels — so 3D hit tests must project the elevated point
// themselves. transform.coordinatePoint(coord, elevationMeters) is internal
// (absent from the public types, present in every 5.x mercator transform);
// if it's ever missing (or throws, e.g. exotic projections), fall back to
// the ground projection — no worse than the pre-fix behavior.
function projectAtAltitude(
	map: maplibregl.Map,
	lon: number,
	lat: number,
	altM: number,
): { x: number; y: number } {
	const transform = (
		map as unknown as {
			transform?: {
				coordinatePoint?: (
					coord: maplibregl.MercatorCoordinate,
					elevation: number,
				) => { x: number; y: number };
			};
		}
	).transform;
	if (transform?.coordinatePoint) {
		try {
			return transform.coordinatePoint(
				maplibregl.MercatorCoordinate.fromLngLat([lon, lat]),
				altM,
			);
		} catch {
			// fall through to ground projection
		}
	}
	return map.project([lon, lat]);
}

/**
 * Single resolver for the pitch × cluster layer matrix (two flags, one
 * writer — split writers previously stomped each other's visibility).
 * Pitched: everything renders as 3D plane slabs (flat icons AND flat cluster
 * blobs hide); flat: cluster decides between icons and blobs.
 */
export function planeLayerVisibility(cluster: boolean, pitched: boolean): Record<string, boolean> {
	return {
		"flights-dots": !cluster && !pitched,
		"flights-notable": !pitched,
		"flight-trails": !cluster && !pitched,
		"cluster-circles": cluster && !pitched,
		"cluster-counts": cluster && !pitched,
		"cluster-planes": cluster && !pitched,
		"ghost-dots": !pitched,
		"ghost-notable": !pitched,
		"planes-3d": pitched,
		"trails-3d": pitched && !cluster,
		"ghost-3d": pitched,
		"track-curtain": pitched,
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
// Ghost pins replay history under the live planes; the reduced opacity is the
// "this is not live" cue (ghosts-under-live rendering).
const GHOST_OPACITY = 0.4;
const GHOST_STROKE_COLOR = "#ffffff";

export const FlightMap: FC<FlightMapProps> = ({
	ref: handleRef,
	positions, seedPositions, basemapUrls, trackGeoJSON, curtainGeoJSON = null, nowMs, playing,
	mapStyle, darkMap, pinColor, notablePinColor, radarSweep, trailMultiplier,
	loopEnabled = false, loopWindowMs = 1_800_000,
	loopClock = IDLE_LOOP_CLOCK, replayBuffer = EMPTY_REPLAY_BUFFER,
	visibleFlights = null,
	globe = false, threeD = false, cluster = false,
	selectMode = "off", onAreaSelect, onPitchedChange,
	onSelectFlight, onClearSelection,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const loadedRef = useRef(false);
	// Latest props read inside map event handlers registered once at create time.
	const positionsRef = useRef(positions);
	positionsRef.current = positions;
	const seedRef = useRef(seedPositions);
	seedRef.current = seedPositions;
	const cbRef = useRef({ onSelectFlight, onClearSelection, onAreaSelect, onPitchedChange });
	cbRef.current = { onSelectFlight, onClearSelection, onAreaSelect, onPitchedChange };
	const selectModeRef = useRef<SelectMode>(selectMode);
	selectModeRef.current = selectMode;
	// In-flight drag state (mutated at event rate); the overlay div re-renders
	// through React state so the visual tracks the pointer.
	const dragRef = useRef<DragPixels | null>(null);
	const [overlay, setOverlay] = useState<{ mode: "rect" | "circle"; d: DragPixels } | null>(null);
	const colorsRef = useRef<FlightMapColors>({ mapStyle, darkMap, pinColor, notablePinColor });
	colorsRef.current = { mapStyle, darkMap, pinColor, notablePinColor };
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
			const altFt = altitudeFtAt(m, now);
			if (altFt <= 0) continue;
			const head = extrapolate(m, now);
			const p = projectAtAltitude(map, head.lon, head.lat, exaggeratedHeightM(altFt));
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
			map.addSource("flights", {
				type: "geojson",
				data: motionPointsToGeoJSON(motionBufferRef.current, nowMsRef.current),
			});
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
				filter: ["!=", ["get", "notable"], true],
				layout: {
					"icon-image": PLANE_ICON_ID,
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
			// notable-flights data story loads AA11/UA175/AA77/UA93).
			map.addLayer({
				id: "flights-notable", type: "symbol", source: "flights",
				filter: ["==", ["get", "notable"], true],
				layout: {
					"icon-image": PLANE_NOTABLE_ICON_ID,
					"icon-rotate": ["-", ["get", "heading"], 90],
					"icon-rotation-alignment": "map",
					"icon-allow-overlap": true,
					"icon-ignore-placement": true,
				},
			});
			void installPlaneIcons(map, colors.pinColor, colors.notablePinColor);
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
					"icon-image": PLANE_ICON_ID,
					"icon-size": ["interpolate", ["linear"], ["zoom"], 4, 1, 9, 1.5],
					"icon-rotate": ["-", ["get", "heading"], 90],
					"icon-rotation-alignment": "map",
					"icon-allow-overlap": true,
					"icon-ignore-placement": true,
				},
			});
			// 3D planes (issue #224): while pitched, each aircraft is a heading-
			// rotated plane-silhouette slab floating AT its altitude (base →
			// height are both up there); the flat icons hide. Replaces the
			// original ground-to-altitude drop columns, which read as bars
			// growing out of grounded planes.
			map.addSource("planes-3d", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "planes-3d", type: "fill-extrusion", source: "planes-3d",
				layout: { visibility: pitchedRef.current ? "visible" : "none" },
				paint: {
					"fill-extrusion-color": [
						"case", ["==", ["get", "notable"], true],
						colors.notablePinColor, colors.pinColor,
					],
					"fill-extrusion-base": ["get", "base"],
					"fill-extrusion-height": ["get", "height"],
					"fill-extrusion-opacity": 0.9,
				},
			});
			// Floating trail ribbons + ghost pucks: the 3D counterparts of the
			// flat breadcrumb lines and loop-mode ghost circles (lines and
			// circles are ground-clamped in MapLibre). Fed by the rAF loop only
			// while pitched.
			map.addSource("trails-3d", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "trails-3d", type: "fill-extrusion", source: "trails-3d",
				layout: { visibility: "none" },
				paint: {
					"fill-extrusion-color": trailColor(colors.mapStyle, colors.darkMap),
					"fill-extrusion-base": ["get", "base"],
					"fill-extrusion-height": ["get", "height"],
					"fill-extrusion-opacity": 0.45,
				},
			});
			map.addSource("ghost-3d", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "ghost-3d", type: "fill-extrusion", source: "ghost-3d",
				layout: { visibility: "none" },
				paint: {
					"fill-extrusion-color": [
						"case", ["==", ["get", "notable"], true],
						colors.notablePinColor, colors.pinColor,
					],
					"fill-extrusion-base": ["get", "base"],
					"fill-extrusion-height": ["get", "height"],
					"fill-extrusion-opacity": GHOST_OPACITY,
				},
			});
			// Selected-flight curtain wall — same pitch gating as the columns;
			// data arrives via the curtainGeoJSON prop effect below.
			map.addSource("track-curtain", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "track-curtain", type: "fill-extrusion", source: "track-curtain",
				layout: { visibility: pitchedRef.current ? "visible" : "none" },
				paint: {
					"fill-extrusion-color": TRACK_LINE_COLOR,
					"fill-extrusion-height": ["get", "height"],
					// Opaque on purpose: below 1.0 MapLibre draws every sub-quad's
					// internal side walls, and the subdivided ramp moirés into
					// pickets. Opaque abutting boxes read as one continuous wall.
					"fill-extrusion-opacity": 1,
					"fill-extrusion-vertical-gradient": true,
				},
			});
			// Loop-mode ghosts render under BOTH live plane layers ("flights-dots"
			// is the lower of the two, so inserting before it puts ghosts under
			// both) but above the trails. They stay simple circles — visually
			// distinct from the live plane icons, and recolorable via paint (the
			// icons bake their color in). Not clickable: the hit-test below only
			// queries the live layers.
			map.addSource("ghost-flights", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "ghost-dots", type: "circle", source: "ghost-flights",
				paint: {
					"circle-radius": 3, "circle-color": colors.pinColor,
					"circle-opacity": GHOST_OPACITY,
					"circle-stroke-width": 0.5, "circle-stroke-color": GHOST_STROKE_COLOR,
					"circle-stroke-opacity": GHOST_OPACITY,
				},
			}, "flights-dots");
			map.addLayer({
				id: "ghost-notable", type: "circle", source: "ghost-flights",
				filter: ["==", ["get", "notable"], true],
				paint: {
					"circle-radius": 5, "circle-color": colors.notablePinColor,
					"circle-opacity": GHOST_OPACITY,
					"circle-stroke-width": 1, "circle-stroke-color": GHOST_STROKE_COLOR,
					"circle-stroke-opacity": GHOST_OPACITY,
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
			applyMapColors(map, colorsRef.current);
			// Now that every layer exists, resolve the pitch × cluster visibility
			// matrix ONCE from the actual camera. The jumpTo pitch seed above
			// fires "pitch" BEFORE the layers are added (its handler skips layer
			// writes while loadedRef is false — flipped only here, at the very
			// end), so a 3D-restored session must not depend on that event: this
			// is what hides the 2D pins after a refresh with 3D persisted on.
			pitchedRef.current = map.getPitch() > 5;
			for (const [id, visible] of Object.entries(
				planeLayerVisibility(clusterRef.current, pitchedRef.current),
			)) {
				map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
			}
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
			if (loadedRef.current) {
				for (const [id, visible] of Object.entries(
					planeLayerVisibility(clusterRef.current, on),
				)) {
					map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
				}
			}
			dirtyRef.current = true;
			cbRef.current.onPitchedChange?.(on);
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
			map.remove();
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

	// Push the selected flight's altitude curtain (or clear it).
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		(map.getSource("track-curtain") as maplibregl.GeoJSONSource | undefined)?.setData(
			curtainGeoJSON ?? EMPTY_FC,
		);
	}, [curtainGeoJSON]);

	// Re-theme / recolor live. setPaintProperty only — setStyle() would tear
	// down the flights/trails/track sources and layers. Before "load" fires,
	// the load handler's applyMapColors call picks up the latest values.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		applyMapColors(map, { mapStyle, darkMap, pinColor, notablePinColor });
		void installPlaneIcons(map, pinColor, notablePinColor);
	}, [mapStyle, darkMap, pinColor, notablePinColor]);

	// Arm/disarm the select tool: panning off, crosshair cursor, stale drag
	// cleared. Runs pre-load safely (dragPan exists from construction).
	useEffect(() => {
		const map = mapRef.current;
		if (!map) return;
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
		for (const [id, visible] of Object.entries(
			planeLayerVisibility(cluster, pitchedRef.current),
		)) {
			map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
		}
		dirtyRef.current = true;
	}, [cluster]);

	// Mercator ↔ globe. Projection survives style-paint changes, so this only
	// needs to run on the toggle itself (plus the load-time seed above).
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		map.setProjection({ type: globe ? "globe" : "mercator" });
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
		if (threeD) {
			map.setMaxPitch(THREE_D_PITCH);
			map.setMinPitch(THREE_D_MIN_PITCH);
			map.easeTo({ pitch: THREE_D_PITCH, duration: 600 });
		} else {
			map.setMinPitch(0);
			map.setMaxPitch(0);
		}
	}, [threeD]);

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

	// Entering/leaving loop mode: clear the ghost layer when leaving so stale
	// ghosts don't linger under a paused map; dirtyRef redraws once either way.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		if (!loopEnabled) {
			(map.getSource("ghost-flights") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
			(map.getSource("ghost-3d") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
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
			const pointsFc = motionPointsToGeoJSON(buf, now);
			(map.getSource("flights") as maplibregl.GeoJSONSource | undefined)?.setData(pointsFc);
			if (clusterRef.current) {
				(map.getSource("flights-clustered") as maplibregl.GeoJSONSource | undefined)?.setData(
					nonNotableFeatures(pointsFc),
				);
			}
			if (pitchedRef.current) {
				const zoom = map.getZoom();
				const sizeKm = plane3DTargetPx(zoom) * kmPerPixel(zoom, map.getCenter().lat);
				(map.getSource("planes-3d") as maplibregl.GeoJSONSource | undefined)?.setData(
					motionPlanes3DToGeoJSON(buf, now, sizeKm),
				);
			}
			// Clamp: hand-edited persisted state must not build million-point trails.
			const clamped = Math.min(Math.max(trailMultiplierRef.current, 0), TRAIL_MULTIPLIER_MAX);
			const trailPoints = Math.round(TRAIL_POINTS * clamped);
			if (pitchedRef.current) {
				// Floating ribbons replace the ground lines while pitched; width
				// tracks the plane-marker scale.
				const zoomT = map.getZoom();
				const ribbonWidthKm =
					plane3DTargetPx(zoomT) * kmPerPixel(zoomT, map.getCenter().lat) * 0.08;
				(map.getSource("trails-3d") as maplibregl.GeoJSONSource | undefined)?.setData(
					motionTrails3DToGeoJSON(buf, now, trailPoints, ribbonWidthKm),
				);
			} else {
				(map.getSource("flight-trails") as maplibregl.GeoJSONSource | undefined)?.setData(
					motionTrailsToGeoJSON(buf, now, trailPoints),
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
					const ghostRadiusKm =
						plane3DTargetPx(zoomG) * kmPerPixel(zoomG, map.getCenter().lat) * 0.12;
					(map.getSource("ghost-3d") as maplibregl.GeoJSONSource | undefined)?.setData(
						replayGhosts3DAt(loopState.buffer, playhead, loopState.visible, ghostRadiusKm),
					);
				} else {
					(map.getSource("ghost-flights") as maplibregl.GeoJSONSource | undefined)?.setData(
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
