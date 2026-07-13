import type { ExpressionSpecification } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import { type FC, useEffect, useRef } from "react";
import type { WeatherObservation } from "../../Providers/MediaStream/MediaStreamContext";
import {
	applyBasemapStyle,
	type BasemapStyleId,
	type BasemapUrls,
	buildBasemapStyle,
} from "../../lib/basemap/basemapStyles";
import { cToF } from "./weatherUnits";
import { type RadarIndex, frameUrlFor } from "./weatherRadar";

// Register the pmtiles:// protocol once per page. maplibre's addProtocol
// does NOT throw on duplicates (it silently overwrites the handler — verified
// against maplibre-gl 5.x source; FlightMap.tsx's "throws" comment is wrong).
// The module guard + try/catch here exist only to avoid pointlessly replacing
// FlightTracker's already-working registration when both apps are mounted.
let protocolRegistered = false;
function ensurePmtilesProtocol() {
	if (protocolRegistered) return;
	try {
		maplibregl.addProtocol("pmtiles", new Protocol().tile);
	} catch {
		// Already registered by another map on the desktop — safe to ignore.
	}
	protocolRegistered = true;
}

// One station entry as generated into stations.json. Regenerate from repo
// root with:
//   python3 -c "
//   import csv, json
//   rows = [{'station_id': r['station_id'], 'name': r['name'], 'lat': float(r['lat']),
//            'lon': float(r['lon']), 'country': r['country'], 'tz': r['tz'],
//            'nws_zone': r['nws_zone'] or None}
//           for r in csv.DictReader(open('packages/tools/weather-recon/data/stations.csv'))]
//   json.dump(rows, open('packages/frontend/src/Applications/Weather/stations.json', 'w'), indent=2)
//   "
// (source stations.csv has 10 columns; elevation_m/isd_id/wfo are dropped.)
export interface WeatherStation {
	station_id: string;
	name: string;
	lat: number;
	lon: number;
	country: string;
	tz: string;
	nws_zone: string | null;
}

interface WeatherMapProps {
	stations: WeatherStation[];
	observations: Record<string, WeatherObservation>;
	selectedStation: string | null;
	onSelectStation: (stationId: string) => void;
	radarIndex: RadarIndex | null;
	utcMs: number;
	mapStyle: BasemapStyleId;
	darkMap: boolean;
	basemapUrls: BasemapUrls;
}

const NA_CENTER: [number, number] = [-98, 39];
const NA_ZOOM = 3;
const NO_DATA_COLOR = "#9a9a9a";
const SELECTION_RING_COLOR = "#ffffff";
const RADAR_OPACITY = 0.65;

// Cold blues below freezing, through teal 50s / green 60s / orange 70-80s /
// red 90+; a station with no reading yet (no temp_f property) renders grey.
const TEMP_COLOR_EXPRESSION = [
	"case",
	["!", ["has", "temp_f"]], NO_DATA_COLOR,
	[
		"step",
		["get", "temp_f"],
		"#2a6fdb", // < 32°F
		32, "#63a9e0", // 32-49°F
		50, "#2ca58d", // 50-59°F
		60, "#4caf50", // 60-69°F
		70, "#ffa726", // 70-89°F
		90, "#e53935", // 90°F+
	],
] as unknown as ExpressionSpecification;

function buildStationsGeoJSON(
	stations: WeatherStation[],
	observations: Record<string, WeatherObservation>,
): GeoJSON.FeatureCollection {
	return {
		type: "FeatureCollection",
		features: stations.map((s) => {
			const obs = observations[s.station_id];
			const properties: Record<string, unknown> = { station_id: s.station_id, name: s.name };
			if (obs?.temp_c !== undefined) properties.temp_f = cToF(obs.temp_c);
			return {
				type: "Feature",
				geometry: { type: "Point", coordinates: [s.lon, s.lat] },
				properties,
			} satisfies GeoJSON.Feature;
		}),
	};
}

// Add (once) or update the radar overlay for the frame resolved at utcMs.
// Tracks the last-applied frame URL in lastUrlRef so unchanged/null
// resolutions (before the first available frame) are true no-ops — no
// redundant updateImage calls, and no flicker when the clock advances within
// the same 5-minute bucket.
function syncRadarFrame(
	map: maplibregl.Map,
	index: RadarIndex | null,
	utcMs: number,
	lastUrlRef: React.MutableRefObject<string | null>,
) {
	if (!index) return;
	const url = frameUrlFor(index, utcMs);
	if (url === null || url === lastUrlRef.current) return;
	lastUrlRef.current = url;
	const existing = map.getSource("radar") as maplibregl.ImageSource | undefined;
	if (existing) {
		existing.updateImage({ url });
		return;
	}
	map.addSource("radar", {
		type: "image",
		url,
		coordinates: index.bounds as [
			[number, number], [number, number], [number, number], [number, number],
		],
	});
	map.addLayer(
		{ id: "radar", type: "raster", source: "radar", paint: { "raster-opacity": RADAR_OPACITY } },
		"countries",
	);
}

export const WeatherMap: FC<WeatherMapProps> = ({
	stations, observations, selectedStation, onSelectStation, radarIndex, utcMs, mapStyle, darkMap, basemapUrls,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const loadedRef = useRef(false);

	// Latest props read inside map event handlers registered once at create time.
	const stationsRef = useRef(stations);
	stationsRef.current = stations;
	const observationsRef = useRef(observations);
	observationsRef.current = observations;
	const selectedStationRef = useRef(selectedStation);
	selectedStationRef.current = selectedStation;
	const radarIndexRef = useRef(radarIndex);
	radarIndexRef.current = radarIndex;
	const utcMsRef = useRef(utcMs);
	utcMsRef.current = utcMs;
	const styleRef = useRef({ mapStyle, darkMap });
	styleRef.current = { mapStyle, darkMap };
	const cbRef = useRef({ onSelectStation });
	cbRef.current = { onSelectStation };
	const lastRadarUrlRef = useRef<string | null>(null);

	// Create the map once (basemapUrls is effectively stable from env).
	useEffect(() => {
		if (!containerRef.current) return;
		ensurePmtilesProtocol();
		const map = new maplibregl.Map({
			container: containerRef.current,
			style: buildBasemapStyle(basemapUrls, styleRef.current.mapStyle, styleRef.current.darkMap),
			center: NA_CENTER,
			zoom: NA_ZOOM,
			attributionControl: false,
		});
		mapRef.current = map;

		map.on("load", () => {
			loadedRef.current = true;

			// Radar goes in first so it renders below the basemap's country/state
			// borders and the station pins added next.
			syncRadarFrame(map, radarIndexRef.current, utcMsRef.current, lastRadarUrlRef);

			map.addSource("stations", {
				type: "geojson",
				data: buildStationsGeoJSON(stationsRef.current, observationsRef.current),
			});
			map.addLayer({
				id: "stations", type: "circle", source: "stations",
				paint: {
					"circle-radius": 5,
					"circle-color": TEMP_COLOR_EXPRESSION,
					"circle-stroke-width": 1,
					"circle-stroke-color": "#ffffff",
				},
			});
			map.addLayer({
				id: "stations-selected", type: "circle", source: "stations",
				filter: ["==", ["get", "station_id"], selectedStationRef.current ?? ""],
				paint: {
					"circle-radius": 9,
					"circle-color": "rgba(0,0,0,0)",
					"circle-stroke-width": 2,
					"circle-stroke-color": SELECTION_RING_COLOR,
				},
			});
			map.on("click", "stations", (e) => {
				const f = e.features?.[0];
				if (f?.properties) cbRef.current.onSelectStation(String(f.properties.station_id));
			});

			applyBasemapStyle(map, styleRef.current.mapStyle, styleRef.current.darkMap);
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

	// Rebuild pins when the station list or the latest observations change.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		const src = map.getSource("stations") as maplibregl.GeoJSONSource | undefined;
		src?.setData(buildStationsGeoJSON(stations, observations));
	}, [stations, observations]);

	// Move the selection ring without touching the pins themselves.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		map.setFilter("stations-selected", ["==", ["get", "station_id"], selectedStation ?? ""]);
	}, [selectedStation]);

	// Clock-driven radar frame swap. No-ops when the resolved frame hasn't
	// changed (same 5-minute bucket) or there's no frame yet for this instant.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		syncRadarFrame(map, radarIndex, utcMs, lastRadarUrlRef);
	}, [utcMs, radarIndex]);

	// Re-style live. setPaintProperty/setLayoutProperty only — setStyle() would
	// tear down the stations/radar sources and layers.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		applyBasemapStyle(map, mapStyle, darkMap);
	}, [mapStyle, darkMap]);

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
};
