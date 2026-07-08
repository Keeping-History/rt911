import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { type FC, useEffect, useRef } from "react";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { buildBasemapStyle } from "./flightMapStyle";
import {
	type MotionBuffer,
	motionPointsToGeoJSON,
	motionTrailsToGeoJSON,
	updateMotion,
} from "./flightMotion";

// Register the pmtiles:// protocol once per page (adding it twice throws).
let protocolRegistered = false;
function ensurePmtilesProtocol() {
	if (protocolRegistered) return;
	maplibregl.addProtocol("pmtiles", new Protocol().tile);
	protocolRegistered = true;
}

interface FlightMapProps {
	positions: FlightPosition[];
	basemapUrl: string;
	trackGeoJSON: GeoJSON.Feature | null;
	nowMs: number;
	playing: boolean;
	onSelectFlight: (flight: string) => void;
	onClearSelection: () => void;
}

const NA_CENTER: [number, number] = [-98, 39];
const NA_ZOOM = 3;
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };
const FRAME_MS = 66; // ~15 fps animation gate

export const FlightMap: FC<FlightMapProps> = ({
	positions, basemapUrl, trackGeoJSON, nowMs, playing, onSelectFlight, onClearSelection,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const loadedRef = useRef(false);
	// Latest props read inside map event handlers registered once at create time.
	const positionsRef = useRef(positions);
	positionsRef.current = positions;
	const cbRef = useRef({ onSelectFlight, onClearSelection });
	cbRef.current = { onSelectFlight, onClearSelection };

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
			style: buildBasemapStyle(basemapUrl),
			center: NA_CENTER,
			zoom: NA_ZOOM,
			attributionControl: false,
		});
		mapRef.current = map;

		map.on("load", () => {
			loadedRef.current = true;
			updateMotion(motionBufferRef.current, positionsRef.current);
			map.addSource("flights", {
				type: "geojson",
				data: motionPointsToGeoJSON(motionBufferRef.current, nowMsRef.current),
			});
			map.addSource("track", { type: "geojson", data: EMPTY_FC });
			map.addSource("flight-trails", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "track-line", type: "line", source: "track",
				paint: { "line-color": "#b22222", "line-width": 2 },
			});
			// Comet tails, drawn under the dots.
			map.addLayer({
				id: "flight-trails", type: "line", source: "flight-trails",
				paint: { "line-color": "#5a5a5a", "line-width": 1.2, "line-opacity": 0.35 },
			});
			map.addLayer({
				id: "flights-dots", type: "circle", source: "flights",
				paint: {
					"circle-radius": 3, "circle-color": "#3a3a3a",
					"circle-stroke-width": 0.5, "circle-stroke-color": "#ffffff",
				},
			});
			// Always-on highlight of the notable flights (renders nothing until the
			// notable-flights data story loads AA11/UA175/AA77/UA93).
			map.addLayer({
				id: "flights-notable", type: "circle", source: "flights",
				filter: ["==", ["get", "notable"], true],
				paint: {
					"circle-radius": 5, "circle-color": "#c0202a",
					"circle-stroke-width": 1, "circle-stroke-color": "#ffffff",
				},
			});
		});

		const selectFromClick = (e: maplibregl.MapLayerMouseEvent) => {
			const f = e.features?.[0];
			if (f?.properties) cbRef.current.onSelectFlight(String(f.properties.flight));
		};
		map.on("click", "flights-dots", selectFromClick);
		map.on("click", "flights-notable", selectFromClick);
		map.on("click", (e) => {
			const hits = map.queryRenderedFeatures(e.point, {
				layers: ["flights-dots", "flights-notable"],
			});
			if (hits.length === 0) cbRef.current.onClearSelection();
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
			if (!playingRef.current && !dirtyRef.current) {
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
			(map.getSource("flight-trails") as maplibregl.GeoJSONSource | undefined)?.setData(
				motionTrailsToGeoJSON(buf, now),
			);
		};
		let raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, []);

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
};
