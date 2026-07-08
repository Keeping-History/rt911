import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { type FC, useEffect, useRef } from "react";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { flightsToGeoJSON } from "./flightGeoJSON";
import { buildBasemapStyle } from "./flightMapStyle";

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
	onSelectFlight: (flight: string) => void;
	onClearSelection: () => void;
}

const NA_CENTER: [number, number] = [-98, 39];
const NA_ZOOM = 3;
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

export const FlightMap: FC<FlightMapProps> = ({
	positions, basemapUrl, trackGeoJSON, onSelectFlight, onClearSelection,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const loadedRef = useRef(false);
	// Latest props read inside map event handlers registered once at create time.
	const positionsRef = useRef(positions);
	positionsRef.current = positions;
	const cbRef = useRef({ onSelectFlight, onClearSelection });
	cbRef.current = { onSelectFlight, onClearSelection };

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
			map.addSource("flights", { type: "geojson", data: flightsToGeoJSON(positionsRef.current) });
			map.addSource("track", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "track-line", type: "line", source: "track",
				paint: { "line-color": "#b22222", "line-width": 2 },
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

	// Push the current airborne set whenever it changes.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const src = map.getSource("flights") as maplibregl.GeoJSONSource | undefined;
		src?.setData(flightsToGeoJSON(positions));
	}, [positions]);

	// Push the selected track (or clear it).
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const src = map.getSource("track") as maplibregl.GeoJSONSource | undefined;
		src?.setData(trackGeoJSON ? { type: "FeatureCollection", features: [trackGeoJSON] } : EMPTY_FC);
	}, [trackGeoJSON]);

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
};
