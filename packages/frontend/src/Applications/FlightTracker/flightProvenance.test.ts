import { describe, expect, it } from "vitest";
import {
	SOURCE_ESTIMATED,
	SOURCE_RADAR,
	isEstimated,
	orderedTrackSources,
	sourceDashExpression,
	sourceLabel,
	sourceOpacityExpression,
} from "./flightProvenance";
import { buildTrackSegments } from "./flightTrackSegments";

describe("flightProvenance", () => {
	it("recognizes estimated positions only", () => {
		expect(isEstimated(SOURCE_ESTIMATED)).toBe(true);
		expect(isEstimated(SOURCE_RADAR)).toBe(false);
		expect(isEstimated(undefined)).toBe(false); // historical reconstruction
	});

	it("dashes and dims estimated stretches, leaves radar solid", () => {
		const dash = sourceDashExpression() as unknown as unknown[];
		const op = sourceOpacityExpression() as unknown as unknown[];
		expect(dash[0]).toBe("case");
		expect(dash[1]).toEqual(["==", ["get", "source"], SOURCE_ESTIMATED]);
		expect(dash[3]).toEqual(["literal", [1, 0]]); // solid fallback
		expect(op[2]).toBeLessThan(op[3] as number); // estimated dimmer than radar
	});

	it("lists sources in track order, defaulting absent to radar", () => {
		expect(
			orderedTrackSources([
				{ source: SOURCE_ESTIMATED },
				{ source: SOURCE_RADAR },
				{ source: SOURCE_RADAR },
				{ source: SOURCE_ESTIMATED },
			]),
		).toEqual([SOURCE_ESTIMATED, SOURCE_RADAR]);
		expect(orderedTrackSources([{}])).toEqual([SOURCE_RADAR]);
	});

	it("labels both provenance values for the legend", () => {
		expect(sourceLabel(SOURCE_RADAR)).toMatch(/radar/i);
		expect(sourceLabel(SOURCE_ESTIMATED)).toMatch(/estimated/i);
	});
});

describe("buildTrackSegments with provenance", () => {
	it("breaks a run where the source changes and tags each segment", () => {
		const pts = [
			{ lat: 40, lon: -75, source: SOURCE_RADAR },
			{ lat: 41, lon: -76, source: SOURCE_RADAR },
			{ lat: 42, lon: -77, source: SOURCE_ESTIMATED },
			{ lat: 43, lon: -78, source: SOURCE_ESTIMATED },
		];
		const feats = buildTrackSegments(pts);
		expect(feats).toHaveLength(2);
		expect(feats[0].properties?.source).toBe(SOURCE_RADAR);
		expect(feats[1].properties?.source).toBe(SOURCE_ESTIMATED);
		// segments share the boundary vertex so the drawn line has no gap
		const a = feats[0].geometry as GeoJSON.LineString;
		const b = feats[1].geometry as GeoJSON.LineString;
		expect(a.coordinates[a.coordinates.length - 1]).toEqual(b.coordinates[0]);
	});

	it("breaks on phase changes too, and carries both properties", () => {
		const feats = buildTrackSegments([
			{ lat: 40, lon: -75, phase: "takeoff", source: SOURCE_RADAR },
			{ lat: 41, lon: -76, phase: "takeoff", source: SOURCE_RADAR },
			{ lat: 42, lon: -77, phase: "artcc", source: SOURCE_RADAR },
			{ lat: 43, lon: -78, phase: "artcc", source: SOURCE_RADAR },
		]);
		expect(feats).toHaveLength(2);
		expect(feats[0].properties?.phase).toBe("takeoff");
		expect(feats[1].properties?.phase).toBe("artcc");
		expect(feats[1].properties?.source).toBe(SOURCE_RADAR);
	});
});
