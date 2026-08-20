import { describe, expect, it } from "vitest";
import {
	type MapPoi,
	distinctLayers,
	visiblePois,
	detailTitleFor,
	POI_DETAIL_FIELDS,
	POI_LAYER_PALETTE,
	poiLayerConfigs,
	unclusteredAirportFilter,
	splitPoisForRender,
	layerIndexOf,
} from "./mapPois";
import { DEFAULT_FLIGHT_POI_SETTINGS } from "./flightMapSettings";

const poi = (over: Partial<MapPoi>): MapPoi => ({
	id: 1, name: "Test", layer: "Major Airports", category: "airport",
	detailTitle: "Airport Details", lat: 1, lon: 2,
	iata: "TST", icao: "KTST", city: "Town", region: "ST", details: null,
	...over,
});

const air = (id: number, layer: string, hub?: string): MapPoi =>
	poi({ id, layer, category: "airport", details: hub ? { hub_class: hub } : {} });

describe("visiblePois", () => {
	const pois = [
		poi({ id: 1, layer: "Major Airports" }),
		poi({ id: 2, layer: "Air Bases" }),
	];
	it("returns [] when the master switch is off", () => {
		expect(visiblePois(pois, false, [])).toEqual([]);
	});
	it("returns all when nothing is disabled", () => {
		expect(visiblePois(pois, true, []).map((p) => p.id)).toEqual([1, 2]);
	});
	it("drops disabled layers", () => {
		expect(visiblePois(pois, true, ["Air Bases"]).map((p) => p.id)).toEqual([1]);
	});
	it("keeps a layer not present in the disabled list (new layers default visible)", () => {
		expect(visiblePois(pois, true, ["Nonexistent"]).map((p) => p.id)).toEqual([1, 2]);
	});
});

describe("distinctLayers", () => {
	it("returns unique layer names sorted", () => {
		const pois = [poi({ layer: "B" }), poi({ layer: "A" }), poi({ layer: "B" })];
		expect(distinctLayers(pois)).toEqual(["A", "B"]);
	});
});

describe("detailTitleFor", () => {
	it("uses the poi's detailTitle when set", () => {
		expect(detailTitleFor(poi({ detailTitle: "Airport Details" }))).toBe("Airport Details");
	});
	it("falls back when null", () => {
		expect(detailTitleFor(poi({ detailTitle: null }))).toBe("Point of Interest");
	});
});

describe("POI_DETAIL_FIELDS", () => {
	it("formats enplanements with thousands separators", () => {
		const f = POI_DETAIL_FIELDS.find((x) => x.key === "enplanements_2000")!;
		expect(f.format(19833823)).toBe("19,833,823");
	});
});

describe("poiLayerConfigs", () => {
	const pois = [air(1, "Major Airports"), air(2, "Air Bases")];
	it("one config per enabled layer with index + palette color, clustered by default", () => {
		const cfg = poiLayerConfigs(pois, { ...DEFAULT_FLIGHT_POI_SETTINGS });
		expect(cfg.map((c) => c.layer)).toEqual(["Air Bases", "Major Airports"]); // sorted
		expect(cfg[0]).toMatchObject({ index: 0, color: POI_LAYER_PALETTE[0], clustered: true });
		expect(cfg[1].index).toBe(1);
	});
	it("marks a layer in unclusteredLayers as clustered:false", () => {
		const cfg = poiLayerConfigs(pois, { ...DEFAULT_FLIGHT_POI_SETTINGS, unclusteredLayers: ["Major Airports"] });
		expect(cfg.find((c) => c.layer === "Major Airports")!.clustered).toBe(false);
	});
	it("returns [] when master disabled and drops disabled layers", () => {
		expect(poiLayerConfigs(pois, { ...DEFAULT_FLIGHT_POI_SETTINGS, enabled: false })).toEqual([]);
		expect(poiLayerConfigs(pois, { ...DEFAULT_FLIGHT_POI_SETTINGS, disabledLayers: ["Air Bases"] }).map((c) => c.layer))
			.toEqual(["Major Airports"]);
	});
});

describe("unclusteredAirportFilter", () => {
	it("keeps only Large-hub airports, passes non-airport categories through", () => {
		const rows = [air(1, "A", "Large"), air(2, "A", "Medium"), air(3, "A"), poi({ id: 4, category: "base", details: {} })];
		expect(unclusteredAirportFilter(rows).map((p) => p.id)).toEqual([1, 4]);
	});
});

describe("splitPoisForRender", () => {
	it("routes clustered vs plain by layer, filters the plain airports to Large", () => {
		const pois = [air(1, "Major Airports", "Large"), air(2, "Major Airports", "Medium"), air(3, "Air Bases")];
		const configs = poiLayerConfigs(pois, { ...DEFAULT_FLIGHT_POI_SETTINGS, unclusteredLayers: ["Major Airports"] });
		const { clustered, plain } = splitPoisForRender(pois, configs);
		expect(clustered.map((p) => p.id)).toEqual([3]);        // Air Bases still clustered
		expect(plain.map((p) => p.id)).toEqual([1]);            // Major Airports unclustered → Large only
	});
});

describe("layerIndexOf", () => {
	it("maps layer name to its config index", () => {
		const configs = poiLayerConfigs([air(1, "Air Bases"), air(2, "Major Airports")], { ...DEFAULT_FLIGHT_POI_SETTINGS });
		expect(layerIndexOf(configs).get("Major Airports")).toBe(1);
	});
});
