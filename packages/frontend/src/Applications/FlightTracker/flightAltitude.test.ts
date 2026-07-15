import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { updateMotion, type MotionBuffer } from "./flightMotion";
import {
	ALT_EXAGGERATION,
	FT_TO_M,
	curtainToGeoJSON,
	diamondRing,
	exaggeratedHeightM,
	motionColumnsToGeoJSON,
} from "./flightAltitude";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "DL404", start_date: "2001-09-11T13:00:00Z",
	lat: 40, lon: -74, alt_ft: 33_000, ...over,
});

function bufferWith(items: Partial<FlightPosition>[]): MotionBuffer {
	const buf: MotionBuffer = new Map();
	updateMotion(buf, items.map((o, i) => pos({ id: i + 1, ...o })));
	return buf;
}

describe("diamondRing", () => {
	it("closes the ring and compensates longitude width by latitude", () => {
		const ring = diamondRing(-74, 40, 1.5);
		expect(ring).toHaveLength(5);
		expect(ring[0]).toEqual(ring[4]);
		const lonHalf = Math.abs(ring[0][0] - -74);
		const latHalf = Math.abs(ring[1][1] - 40);
		expect(lonHalf).toBeGreaterThan(latHalf); // 1/cos(40°) stretch
	});
});

describe("motionColumnsToGeoJSON", () => {
	it("emits one extruded diamond per flight with exaggerated metric height", () => {
		const fc = motionColumnsToGeoJSON(bufferWith([{ flight: "DL404", alt_ft: 33_000 }]), 0);
		expect(fc.features).toHaveLength(1);
		const f = fc.features[0];
		expect(f.properties!.flight).toBe("DL404");
		expect(f.properties!.notable).toBe(false);
		expect(f.properties!.height).toBeCloseTo(33_000 * FT_TO_M * ALT_EXAGGERATION, 0);
		expect(exaggeratedHeightM(33_000)).toBeCloseTo(100_584, 0);
	});

	it("marks notables and skips grounded flights", () => {
		const fc = motionColumnsToGeoJSON(
			bufferWith([
				{ flight: "AA11", alt_ft: 26_000 },
				{ flight: "N1", alt_ft: 0 },
			]),
			0,
		);
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].properties!.notable).toBe(true);
	});
});

describe("curtainToGeoJSON", () => {
	const sample = (lon: number, lat: number, alt_ft: number) => ({
		lon, lat, alt_ft, utc: "2001-09-11T13:00:00Z",
	});

	it("builds one closed quad per consecutive pair at the pair's max height", () => {
		const fc = curtainToGeoJSON([
			sample(-74, 40, 10_000),
			sample(-73.9, 40.1, 20_000),
			sample(-73.8, 40.2, 15_000),
		]);
		expect(fc.features).toHaveLength(2);
		for (const f of fc.features) {
			const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
			expect(ring).toHaveLength(5);
			expect(ring[0]).toEqual(ring[4]);
		}
		expect(fc.features[0].properties!.height).toBeCloseTo(exaggeratedHeightM(20_000), 5);
		expect(fc.features[1].properties!.height).toBeCloseTo(exaggeratedHeightM(20_000), 5);
	});

	it("returns an empty FC for null or single-sample profiles", () => {
		expect(curtainToGeoJSON(null).features).toEqual([]);
		expect(curtainToGeoJSON([sample(-74, 40, 10_000)]).features).toEqual([]);
	});
});
