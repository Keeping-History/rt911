import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeatherObservation } from "../../Providers/MediaStream/MediaStreamContext";
import type { RadarIndex } from "./weatherRadar";
import type { WeatherStation } from "./WeatherMap";

// ---- maplibre-gl mock (jsdom has no WebGL) --------------------------------
// Same vi.hoisted FakeMap pattern as FlightMap.test.tsx, extended with an
// image-source stub (updateImage) and setFilter recording for the selection
// ring layer.
type Handler = (...a: unknown[]) => void;
const FakeMap = vi.hoisted(() => {
	class FakeMap {
		static last: FakeMap | null = null;
		handlers: Record<string, Handler[]> = {};
		layerHandlers: Record<string, Record<string, Handler[]>> = {};
		sources: Record<string, { data?: unknown; type: string; url?: string; coordinates?: unknown }> = {};
		layers: Record<string, unknown>[] = [];
		paint: Record<string, Record<string, unknown>> = {};
		layout: Record<string, Record<string, unknown>> = {};
		filters: Record<string, unknown> = {};
		updatedImages: { source: string; url: string }[] = [];
		style: unknown;
		removed = false;
		constructor(opts: { style: unknown }) {
			this.style = opts.style;
			FakeMap.last = this;
		}
		on(ev: string, a?: unknown, b?: unknown) {
			if (typeof a === "string" && typeof b === "function") {
				(this.layerHandlers[ev] ??= {})[a] ??= [];
				this.layerHandlers[ev][a].push(b as Handler);
			} else if (typeof a === "function") {
				(this.handlers[ev] ??= []).push(a as Handler);
			}
		}
		fire(ev: string, payload?: unknown) { for (const h of this.handlers[ev] ?? []) h(payload); }
		fireLayer(ev: string, layer: string, payload: unknown) {
			for (const h of this.layerHandlers[ev]?.[layer] ?? []) h(payload);
		}
		addSource(id: string, def: { type: string; data?: unknown; url?: string; coordinates?: unknown }) {
			this.sources[id] = { ...def };
		}
		addLayer(def: Record<string, unknown>, beforeId?: string) {
			this.layers.push({ ...def, beforeId });
		}
		setPaintProperty(layerId: string, name: string, value: unknown) {
			(this.paint[layerId] ??= {})[name] = value;
		}
		setLayoutProperty(layerId: string, name: string, value: unknown) {
			(this.layout[layerId] ??= {})[name] = value;
		}
		skies: unknown[] = [];
		setSky(sky: unknown) { this.skies.push(sky); }
		setFilter(layerId: string, filter: unknown) {
			this.filters[layerId] = filter;
		}
		getSource(id: string) {
			const s = this.sources[id];
			if (!s) return undefined;
			if (s.type === "image") {
				return {
					updateImage: (opts: { url: string }) => {
						s.url = opts.url;
						this.updatedImages.push({ source: id, url: opts.url });
					},
				};
			}
			return { setData: (d: unknown) => { s.data = d; } };
		}
		queryResult: unknown[] = [];
		queryRenderedFeatures() { return this.queryResult; }
		project(c: [number, number]) { return { x: c[0], y: c[1] }; }
		resize() {}
		remove() { this.removed = true; }
	}
	return FakeMap;
});
vi.mock("maplibre-gl", () => ({
	default: { Map: FakeMap, addProtocol: vi.fn() },
	Map: FakeMap,
	addProtocol: vi.fn(),
}));
vi.mock("pmtiles", () => ({ Protocol: class { tile = vi.fn(); } }));

import { WeatherMap } from "./WeatherMap";

const STATIONS: WeatherStation[] = [
	{ station_id: "KJFK", name: "JFK", lat: 40.64, lon: -73.78, country: "US", tz: "America/New_York", nws_zone: "NYZ178" },
	{ station_id: "KFLG", name: "FLAGSTAFF", lat: 35.14, lon: -111.67, country: "US", tz: "America/Phoenix", nws_zone: null },
];

function buildRadarIndex(overrides: Partial<RadarIndex> = {}): RadarIndex {
	return {
		bounds: [[-126, 50], [-66, 50], [-66, 24], [-126, 24]],
		frames: ["200109111300", "200109111305", "200109111310"],
		missing: [],
		interval_seconds: 300,
		key_prefix: "weather/radar/",
		key_pattern: "n0r_{stamp}.png",
		...overrides,
	};
}

const TEST_URLS = {
	vector: "x.pmtiles",
	satelliteDay: "day.pmtiles",
	satelliteNight: "night.pmtiles",
	terrainDem: "https://x.example/dem.pmtiles",
	coast: "coast.pmtiles",
	borders: "borders.pmtiles",
};

const commonProps = {
	basemapUrls: TEST_URLS,
	mapStyle: "classic" as const,
	darkMap: false,
	onSelectStation: () => {},
};

describe("WeatherMap", () => {
	beforeEach(() => { FakeMap.last = null; });
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("adds the radar image source on load with the index bounds as coordinates", () => {
		const radarIndex = buildRadarIndex();
		render(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={radarIndex} utcMs={Date.parse("2001-09-11T13:05:00.000Z")} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const radarSource = map.sources.radar;
		expect(radarSource).toBeDefined();
		expect(radarSource.coordinates).toEqual(radarIndex.bounds);
		expect(radarSource.url).toBe("https://files.911realtime.org/weather/radar/n0r_200109111305.png");
	});

	it("inserts the radar layer before the countries layer", () => {
		render(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={buildRadarIndex()} utcMs={Date.parse("2001-09-11T13:05:00.000Z")} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const radarLayer = map.layers.find((l) => l.id === "radar") as { beforeId?: string; type: string };
		expect(radarLayer).toBeDefined();
		expect(radarLayer.beforeId).toBe("countries");
		expect(radarLayer.type).toBe("raster");
	});

	it("calls updateImage when the resolved frame's stamp changes, not for the same stamp", () => {
		const radarIndex = buildRadarIndex();
		const { rerender } = render(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={radarIndex} utcMs={Date.parse("2001-09-11T13:05:00.000Z")} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.updatedImages).toHaveLength(0); // initial add uses addSource, not updateImage

		// Same 5-minute bucket — no-op.
		rerender(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={radarIndex} utcMs={Date.parse("2001-09-11T13:05:59.000Z")} />,
		);
		expect(map.updatedImages).toHaveLength(0);

		// New bucket — swaps frames via updateImage.
		rerender(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={radarIndex} utcMs={Date.parse("2001-09-11T13:10:00.000Z")} />,
		);
		expect(map.updatedImages).toEqual([
			{ source: "radar", url: "https://files.911realtime.org/weather/radar/n0r_200109111310.png" },
		]);
	});

	it("does not add a radar source when utcMs is before the first available frame", () => {
		render(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={buildRadarIndex()} utcMs={Date.parse("2001-09-11T12:00:00.000Z")} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.sources.radar).toBeUndefined();
	});

	it("carries temp_f on station pins computed from observations, grey (no property) when absent", () => {
		const observations: Record<string, WeatherObservation> = {
			KJFK: { id: 1, station_id: "KJFK", start_date: "2001-09-11T13:00:00Z", temp_c: 21.1 },
		};
		render(
			<WeatherMap {...commonProps} stations={STATIONS} observations={observations} selectedStation={null}
				radarIndex={null} utcMs={0} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const data = map.sources.stations?.data as {
			features: { properties: { station_id: string; temp_f?: number } }[];
		};
		const jfk = data.features.find((f) => f.properties.station_id === "KJFK")!;
		const flg = data.features.find((f) => f.properties.station_id === "KFLG")!;
		expect(jfk.properties.temp_f).toBeCloseTo(70, 0);
		expect(flg.properties.temp_f).toBeUndefined();
	});

	it("rebuilds pins via setData when observations change", () => {
		const { rerender } = render(
			<WeatherMap {...commonProps} stations={STATIONS} observations={{}} selectedStation={null}
				radarIndex={null} utcMs={0} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const before = map.sources.stations?.data as { features: { properties: { temp_f?: number } }[] };
		expect(before.features.every((f) => f.properties.temp_f === undefined)).toBe(true);

		const observations: Record<string, WeatherObservation> = {
			KFLG: { id: 2, station_id: "KFLG", start_date: "2001-09-11T13:00:00Z", temp_c: 0 },
		};
		rerender(
			<WeatherMap {...commonProps} stations={STATIONS} observations={observations} selectedStation={null}
				radarIndex={null} utcMs={0} />,
		);
		const after = map.sources.stations?.data as {
			features: { properties: { station_id: string; temp_f?: number } }[];
		};
		const flg = after.features.find((f) => f.properties.station_id === "KFLG")!;
		expect(flg.properties.temp_f).toBeCloseTo(32, 0);
	});

	it("filters the selection ring layer by the selected station_id and updates via setFilter", () => {
		const { rerender } = render(
			<WeatherMap {...commonProps} stations={STATIONS} observations={{}} selectedStation={null}
				radarIndex={null} utcMs={0} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const ring = map.layers.find((l) => l.id === "stations-selected") as { filter: unknown };
		expect(ring.filter).toEqual(["==", ["get", "station_id"], ""]);

		rerender(
			<WeatherMap {...commonProps} stations={STATIONS} observations={{}} selectedStation="KJFK"
				radarIndex={null} utcMs={0} />,
		);
		expect(map.filters["stations-selected"]).toEqual(["==", ["get", "station_id"], "KJFK"]);
	});

	it("calls onSelectStation on a pin click", () => {
		const onSelect = vi.fn();
		render(
			<WeatherMap {...commonProps} onSelectStation={onSelect} stations={STATIONS} observations={{}}
				selectedStation={null} radarIndex={null} utcMs={0} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		map.fireLayer("click", "stations", { features: [{ properties: { station_id: "KFLG" } }] });
		expect(onSelect).toHaveBeenCalledWith("KFLG");
	});

	it("removes the map on unmount (frees the WebGL context)", () => {
		const { unmount } = render(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={null} utcMs={0} />,
		);
		const map = FakeMap.last!;
		unmount();
		expect(map.removed).toBe(true);
	});

	it("re-applies basemap theme colors live without re-creating the map", () => {
		const { rerender } = render(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={null} utcMs={0} mapStyle="classic" darkMap={false} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.paint["background"]?.["background-color"]).toBe("#aeb9bf");
		rerender(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={null} utcMs={0} mapStyle="classic" darkMap={true} />,
		);
		expect(FakeMap.last).toBe(map); // no map re-creation
		expect(map.paint["background"]?.["background-color"]).toBe("#12151c");
	});

	it("re-styling to satellite flips ground visibility on the live map", () => {
		const { rerender } = render(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={null} utcMs={0} mapStyle="classic" darkMap={false} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		rerender(
			<WeatherMap {...commonProps} stations={[]} observations={{}} selectedStation={null}
				radarIndex={null} utcMs={0} mapStyle="satellite" darkMap={false} />,
		);
		expect(FakeMap.last).toBe(map); // no map re-creation
		expect(map.layout["satellite-day"]?.visibility).toBe("visible");
		expect(map.layout.land?.visibility).toBe("none");
	});
});
