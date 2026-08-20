import { describe, expect, it } from "vitest";
import { airportCoords, haversineNm } from "./airports";

describe("airportCoords", () => {
	it("resolves known IATA codes ([lon, lat] order) case-insensitively", () => {
		const jfk = airportCoords("JFK");
		expect(jfk).not.toBeNull();
		expect(jfk![0]).toBeCloseTo(-73.78, 1);
		expect(jfk![1]).toBeCloseTo(40.64, 1);
		expect(airportCoords("bos")).toEqual(airportCoords("BOS"));
	});

	it("misses safely on unknown or empty codes", () => {
		expect(airportCoords("ZZZ")).toBeNull();
		expect(airportCoords(null)).toBeNull();
		expect(airportCoords(undefined)).toBeNull();
		expect(airportCoords("")).toBeNull();
	});

	it("covers the 9/11 story airports", () => {
		for (const code of ["BOS", "EWR", "IAD", "LAX", "SFO"]) {
			expect(airportCoords(code)).not.toBeNull();
		}
	});
});

describe("haversineNm", () => {
	it("JFK→LAX is about 2145 nm", () => {
		const d = haversineNm(airportCoords("JFK")!, airportCoords("LAX")!);
		expect(d).toBeGreaterThan(2120);
		expect(d).toBeLessThan(2170);
	});

	it("zero distance for identical points", () => {
		expect(haversineNm([-74, 40], [-74, 40])).toBe(0);
	});
});
