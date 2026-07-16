import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { flightsToGeoJSON } from "./flightGeoJSON";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "AA1002", start_date: "2001-09-11T13:00:00Z",
	lat: 40, lon: -74, alt_ft: 30000, ...over,
});

describe("flightsToGeoJSON", () => {
	it("builds a Point feature per position with [lon,lat] order", () => {
		const fc = flightsToGeoJSON([pos({ id: 7, lat: 40.7, lon: -74.0 })]);
		expect(fc.type).toBe("FeatureCollection");
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].geometry.coordinates).toEqual([-74.0, 40.7]);
		expect(fc.features[0].id).toBe(7);
	});
	it("flags notable flights in properties", () => {
		const fc = flightsToGeoJSON([pos({ flight: "AA11" }), pos({ flight: "AA1002" })]);
		expect(fc.features[0].properties.notable).toBe(true);
		expect(fc.features[1].properties.notable).toBe(false);
	});
	it("defaults optional fields", () => {
		const fc = flightsToGeoJSON([pos({ carrier: undefined, phase: undefined })]);
		expect(fc.features[0].properties.carrier).toBe("");
		expect(fc.features[0].properties.phase).toBe("");
	});
	it("stamps the static builder's features with the generic family", () => {
		const fc = flightsToGeoJSON([
			{ id: 1, flight: "AA1002", start_date: "2001-09-11T13:00:00Z", lat: 40, lon: -74, alt_ft: 30000 },
		]);
		expect(fc.features[0].properties.family).toBe("generic");
	});
});
