import { describe, expect, it } from "vitest";
import {
	type MapPoi,
	distinctLayers,
	visiblePois,
	detailTitleFor,
	POI_DETAIL_FIELDS,
} from "./mapPois";

const poi = (over: Partial<MapPoi>): MapPoi => ({
	id: 1, name: "Test", layer: "Major Airports", category: "airport",
	detailTitle: "Airport Details", lat: 1, lon: 2,
	iata: "TST", icao: "KTST", city: "Town", region: "ST", details: null,
	...over,
});

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
