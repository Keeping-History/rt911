import { describe, expect, it } from "vitest";
import { buildTrackSegments } from "./flightTrackSegments";

const P = (lon: number, phase: string) => ({ lat: 40, lon, phase });

describe("buildTrackSegments", () => {
	it("splits maximal same-phase runs into features sharing boundary vertices", () => {
		const feats = buildTrackSegments([
			P(-1, "takeoff"), P(-2, "takeoff"), P(-3, "artcc"), P(-4, "artcc"),
		]);
		expect(feats).toHaveLength(2);
		expect(feats[0].properties?.phase).toBe("takeoff");
		expect(feats[1].properties?.phase).toBe("artcc");
		// boundary vertex is shared: last coord of seg0 == first coord of seg1.
		const g0 = feats[0].geometry as GeoJSON.LineString;
		const g1 = feats[1].geometry as GeoJSON.LineString;
		expect(g0.coordinates.at(-1)).toEqual(g1.coordinates[0]);
		expect(g0.coordinates).toEqual([[-1, 40], [-2, 40], [-3, 40]]);
	});

	it("returns [] for degenerate input", () => {
		expect(buildTrackSegments([])).toEqual([]);
		expect(buildTrackSegments([P(-1, "takeoff")])).toEqual([]);
	});
});
