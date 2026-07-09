import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { type FC, useEffect, useRef } from "react";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import {
	TRACK_LINE_COLOR,
	applyMapColors,
	buildBasemapStyle,
	type FlightMapColors,
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
	motionPointsToGeoJSON,
	motionTrailsToGeoJSON,
	updateMotion,
} from "./flightMotion";
import {
	RADAR_FALLBACK_COLOR,
	resolveCssColor,
	sweepLineGeoJSON,
	sweepTrailGeoJSON,
} from "./flightRadar";
import { type ReplayBuffer, replayPointsAt } from "./flightReplay";
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

interface FlightMapProps {
	positions: FlightPosition[];
	basemapUrl: string;
	trackGeoJSON: GeoJSON.Feature | null;
	nowMs: number;
	playing: boolean;
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
	onSelectFlight: (flight: string) => void;
	onClearSelection: () => void;
}

const IDLE_LOOP_CLOCK: LoopClock = {
	anchorVirtual: 0,
	anchorWall: 0,
	speed: 1,
	scrubbing: false,
};
const EMPTY_REPLAY_BUFFER: ReplayBuffer = new Map();

const NA_CENTER: [number, number] = [-98, 39];
const NA_ZOOM = 3;
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
	positions, basemapUrl, trackGeoJSON, nowMs, playing,
	darkMap, pinColor, notablePinColor, radarSweep, trailMultiplier,
	loopEnabled = false, loopWindowMs = 1_800_000,
	loopClock = IDLE_LOOP_CLOCK, replayBuffer = EMPTY_REPLAY_BUFFER,
	onSelectFlight, onClearSelection,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const loadedRef = useRef(false);
	// Latest props read inside map event handlers registered once at create time.
	const positionsRef = useRef(positions);
	positionsRef.current = positions;
	const cbRef = useRef({ onSelectFlight, onClearSelection });
	cbRef.current = { onSelectFlight, onClearSelection };
	const colorsRef = useRef<FlightMapColors>({ darkMap, pinColor, notablePinColor });
	colorsRef.current = { darkMap, pinColor, notablePinColor };
	const radarSweepRef = useRef(radarSweep);
	radarSweepRef.current = radarSweep;
	const trailMultiplierRef = useRef(trailMultiplier);
	trailMultiplierRef.current = trailMultiplier;
	const loopRef = useRef({
		enabled: loopEnabled, windowMs: loopWindowMs, clock: loopClock, buffer: replayBuffer,
	});
	loopRef.current = {
		enabled: loopEnabled, windowMs: loopWindowMs, clock: loopClock, buffer: replayBuffer,
	};

	const motionBufferRef = useRef<MotionBuffer>(new Map());
	const nowMsRef = useRef(nowMs);
	nowMsRef.current = nowMs;
	const playingRef = useRef(playing);
	playingRef.current = playing;
	// Smooth virtual clock anchor: virtual instant + the wall time it was set.
	const anchorRef = useRef({ virtual: nowMs, wall: 0 });
	// Whether a frame is owed while paused (buffer/clock changed since last draw).
	const dirtyRef = useRef(true);

	// Create the map once (basemapUrl is effectively stable from env).
	useEffect(() => {
		if (!containerRef.current) return;
		ensurePmtilesProtocol();
		const map = new maplibregl.Map({
			container: containerRef.current,
			style: buildBasemapStyle(basemapUrl, colorsRef.current.darkMap ? "dark" : "light"),
			center: NA_CENTER,
			zoom: NA_ZOOM,
			attributionControl: false,
		});
		mapRef.current = map;

		map.on("load", () => {
			loadedRef.current = true;
			const colors = colorsRef.current;
			const theme = colors.darkMap ? "dark" : "light";
			updateMotion(motionBufferRef.current, positionsRef.current);
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
				paint: { "line-width": 1.2, "line-gradient": trailGradient(theme) },
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
		});

		// Forgiving hit-test: query a small box around the click and select the
		// NEAREST dot within it; clear the selection only when nothing is nearby.
		// (An exact-pixel layer click missed too often on the tiny gliding dots.)
		map.on("click", (e) => {
			const { x, y } = e.point;
			const near = map.queryRenderedFeatures(
				[
					[x - HIT_TOLERANCE, y - HIT_TOLERANCE],
					[x + HIT_TOLERANCE, y + HIT_TOLERANCE],
				],
				{ layers: ["flights-dots", "flights-notable"] },
			);
			if (near.length === 0) {
				cbRef.current.onClearSelection();
				return;
			}
			let best = near[0];
			let bestDist = Number.POSITIVE_INFINITY;
			for (const f of near) {
				if (f.geometry.type !== "Point") continue;
				const pp = map.project(f.geometry.coordinates as [number, number]);
				const d = (pp.x - x) ** 2 + (pp.y - y) ** 2;
				if (d < bestDist) {
					bestDist = d;
					best = f;
				}
			}
			if (best.properties) cbRef.current.onSelectFlight(String(best.properties.flight));
		});

		const ro = new ResizeObserver(() => map.resize());
		ro.observe(containerRef.current);

		return () => {
			ro.disconnect();
			map.remove();
			mapRef.current = null;
			loadedRef.current = false;
		};
	}, [basemapUrl]);

	// Fold each new airborne snapshot into the motion buffer.
	useEffect(() => {
		updateMotion(motionBufferRef.current, positions);
		dirtyRef.current = true;
	}, [positions]);

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

	// Re-theme / recolor live. setPaintProperty only — setStyle() would tear
	// down the flights/trails/track sources and layers. Before "load" fires,
	// the load handler's applyMapColors call picks up the latest values.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		applyMapColors(map, { darkMap, pinColor, notablePinColor });
		void installPlaneIcons(map, pinColor, notablePinColor);
	}, [darkMap, pinColor, notablePinColor]);

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
			(map.getSource("flights") as maplibregl.GeoJSONSource | undefined)?.setData(
				motionPointsToGeoJSON(buf, now),
			);
			// Clamp: hand-edited persisted state must not build million-point trails.
			const clamped = Math.min(Math.max(trailMultiplierRef.current, 0), TRAIL_MULTIPLIER_MAX);
			(map.getSource("flight-trails") as maplibregl.GeoJSONSource | undefined)?.setData(
				motionTrailsToGeoJSON(buf, now, Math.round(TRAIL_POINTS * clamped)),
			);
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
				(map.getSource("ghost-flights") as maplibregl.GeoJSONSource | undefined)?.setData(
					replayPointsAt(loopState.buffer, playhead),
				);
			}
		};
		let raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, []);

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
};
