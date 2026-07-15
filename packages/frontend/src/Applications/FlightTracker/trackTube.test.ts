import { describe, expect, it } from "vitest";
import type { AltitudeSample } from "./flightAltitude";
import { exaggeratedHeightM } from "./flightAltitude";
import { mercatorPerMeter } from "./plane3dMesh";
import { TUBE_SIDES, buildTrackTube, splineTrack } from "./trackTube";

const sample = (lon: number, lat: number, alt_ft: number, i = 0): AltitudeSample => ({
	lon, lat, alt_ft, utc: new Date(Date.UTC(2001, 8, 11, 13, i)).toISOString(),
});

describe("splineTrack", () => {
	it("passes through every original sample at segment joints", () => {
		const profile = [
			sample(-74, 40, 0, 0),
			sample(-73.5, 40.5, 10_000, 1),
			sample(-73, 40.4, 20_000, 2),
			sample(-72.5, 41, 28_000, 3),
		];
		const steps = 4;
		const pts = splineTrack(profile, steps);
		expect(pts).toHaveLength((profile.length - 1) * steps + 1);
		for (let i = 0; i < profile.length; i++) {
			const p = pts[i * steps];
			expect(p.lon).toBeCloseTo(profile[i].lon, 9);
			expect(p.lat).toBeCloseTo(profile[i].lat, 9);
			expect(p.alt_ft).toBeCloseTo(profile[i].alt_ft, 6);
		}
	});

	it("keeps straight legs straight and rounds corners smoothly", () => {
		// Collinear, evenly spaced: interpolation must not bow off the line.
		const straight = splineTrack(
			[sample(-74, 40, 10_000), sample(-73, 40, 10_000), sample(-72, 40, 10_000)],
			4,
		);
		for (const p of straight) {
			expect(p.lat).toBeCloseTo(40, 9);
			expect(p.alt_ft).toBeCloseTo(10_000, 6);
		}
		// A 90° turn: the midpoint of the corner segment pulls inside the
		// straight-line elbow (curved path), instead of tracing the sharp corner.
		const bent = splineTrack(
			[sample(-74, 40, 10_000), sample(-73, 40, 10_000), sample(-73, 41, 10_000)],
			4,
		);
		const nearCorner = bent.filter((p) => p.lon > -73.3 && p.lat < 40.7);
		const offAxis = nearCorner.some(
			(p) => Math.abs(p.lat - 40) > 1e-6 && Math.abs(p.lon + 73) > 1e-6,
		);
		expect(offAxis).toBe(true);
	});

	it("returns the profile unchanged when it is too short to spline", () => {
		expect(splineTrack([], 4)).toHaveLength(0);
		expect(splineTrack([sample(-74, 40, 100)], 4)).toHaveLength(1);
	});
});

describe("buildTrackTube", () => {
	const profile = [
		sample(-74, 40, 1_000, 0),
		sample(-73.5, 40.5, 12_000, 1),
		sample(-73, 41, 24_000, 2),
	];

	it("is empty for null/short profiles", () => {
		expect(buildTrackTube(null).vertexCount).toBe(0);
		expect(buildTrackTube([profile[0]]).vertexCount).toBe(0);
	});

	it("packs center vec4s and unit offset vec3s for every vertex", () => {
		const tube = buildTrackTube(profile);
		expect(tube.vertexCount).toBeGreaterThan(0);
		expect(tube.vertexCount % 3).toBe(0); // whole triangles
		expect(tube.centers).toHaveLength(tube.vertexCount * 4);
		expect(tube.offsets).toHaveLength(tube.vertexCount * 3);
		for (let v = 0; v < tube.vertexCount; v++) {
			const [ox, oy, oz] = [
				tube.offsets[v * 3],
				tube.offsets[v * 3 + 1],
				tube.offsets[v * 3 + 2],
			];
			expect(Math.hypot(ox, oy, oz)).toBeCloseTo(1, 5);
			// Mercator scale rides in .w so the shader can size the radius and
			// elevation without knowing latitude.
			const mpm = tube.centers[v * 4 + 3];
			expect(mpm).toBeGreaterThan(mercatorPerMeter(39.5));
			expect(mpm).toBeLessThan(mercatorPerMeter(41.5));
		}
	});

	it("elevations span the exaggerated altitude range of the profile", () => {
		const tube = buildTrackTube(profile);
		let minE = Infinity;
		let maxE = -Infinity;
		for (let v = 0; v < tube.vertexCount; v++) {
			const e = tube.centers[v * 4 + 2];
			minE = Math.min(minE, e);
			maxE = Math.max(maxE, e);
		}
		expect(minE).toBeGreaterThanOrEqual(0);
		expect(minE).toBeLessThanOrEqual(exaggeratedHeightM(1_000) + 1);
		expect(maxE).toBeGreaterThanOrEqual(exaggeratedHeightM(24_000) - 1);
	});

	it("ring size matches TUBE_SIDES (two triangles per side per step)", () => {
		const steps = 4;
		const tube = buildTrackTube(profile, steps);
		const rings = (profile.length - 1) * steps + 1;
		expect(tube.vertexCount).toBe((rings - 1) * TUBE_SIDES * 2 * 3);
	});
});
