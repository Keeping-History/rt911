import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { AltitudeSample } from "./flightAltitude";
import { exaggeratedHeightM } from "./flightAltitude";
import { phaseColorRgb01 } from "./flightPhases";
import { type MotionBuffer, updateMotion } from "./flightMotion";
import { lngLatToMercator, mercatorPerMeter } from "./plane3dMesh";
import { TUBE_SIDES, buildTrackTube, buildTrailTubes, splineTrack, trailFadeAt } from "./trackTube";

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
		expect(tube.offsets).toHaveLength(tube.vertexCount * 4);
		for (let v = 0; v < tube.vertexCount; v++) {
			const [ox, oy, oz, alpha] = [
				tube.offsets[v * 4],
				tube.offsets[v * 4 + 1],
				tube.offsets[v * 4 + 2],
				tube.offsets[v * 4 + 3],
			];
			expect(Math.hypot(ox, oy, oz)).toBeCloseTo(1, 5);
			expect(alpha).toBe(1); // the selected track never fades
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

describe("buildTrailTubes (smooth 3D trail ribbons)", () => {
	// AA1: three samples heading due east at 1°lon/min, climbing.
	const T0 = Date.parse("2001-09-11T13:00:00Z");
	function buf(): MotionBuffer {
		const b: MotionBuffer = new Map();
		const at = (min: number, lon: number, alt: number): FlightPosition => ({
			id: min + 1, flight: "AA1", start_date: new Date(T0 + min * 60_000).toISOString(),
			lat: 40, lon, alt_ft: alt,
		});
		updateMotion(b, [at(0, -74, 10_000)]);
		updateMotion(b, [at(1, -73, 12_000)]);
		updateMotion(b, [at(2, -72, 14_000)]);
		return b;
	}

	it("builds two-vertex rings with horizontal unit offsets", () => {
		const tube = buildTrailTubes(buf(), T0 + 2 * 60_000, {
			displayPoints: 20, steps: 2, headOffsetM: 0,
		});
		expect(tube.vertexCount).toBeGreaterThan(0);
		expect(tube.vertexCount % 3).toBe(0);
		expect(tube.centers).toHaveLength(tube.vertexCount * 4);
		expect(tube.offsets).toHaveLength(tube.vertexCount * 4);
		for (let v = 0; v < tube.vertexCount; v++) {
			const [ox, oy, oz, alpha] = [
				tube.offsets[v * 4], tube.offsets[v * 4 + 1],
				tube.offsets[v * 4 + 2], tube.offsets[v * 4 + 3],
			];
			expect(Math.hypot(ox, oy, oz)).toBeCloseTo(1, 5);
			expect(oz).toBe(0); // ribbon offsets are horizontal
			expect(alpha).toBeGreaterThanOrEqual(0);
			expect(alpha).toBeLessThanOrEqual(1);
		}
	});

	it("fades the ribbon from opaque at the plane to transparent at the tip", () => {
		const tube = buildTrailTubes(buf(), T0 + 2 * 60_000, {
			displayPoints: 20, steps: 1, headOffsetM: 0,
		});
		// Vertices are emitted oldest ring -> newest: the FIRST vertex sits on
		// the oldest tip (100% from the plane, alpha 0) and the LAST on the
		// head ring (0% from the plane, alpha 1).
		expect(tube.offsets[3]).toBeCloseTo(0, 5);
		expect(tube.offsets[(tube.vertexCount - 1) * 4 + 3]).toBeCloseTo(1, 5);
	});

	it("head rides at the plane's GLIDED altitude and pulls back to the tail", () => {
		// 30s past the last sample: glided position lon -71.5, glided altitude
		// 15,000ft (2,000 ft/min climb continued) — NOT the raw sample's 14,000.
		const now = T0 + 2 * 60_000 + 30_000;
		const pullbackM = 2_000;
		const tube = buildTrailTubes(buf(), now, {
			displayPoints: 20, steps: 1, headOffsetM: pullbackM,
		});
		let maxElev = -Infinity;
		let maxLonMerc = -Infinity;
		for (let v = 0; v < tube.vertexCount; v++) {
			maxElev = Math.max(maxElev, tube.centers[v * 4 + 2]);
			maxLonMerc = Math.max(maxLonMerc, tube.centers[v * 4]);
		}
		expect(maxElev).toBeCloseTo(exaggeratedHeightM(15_000), 0);
		// Eastbound: the ribbon's end sits WEST of the glided head by the
		// pullback (tail alignment), never at/under the plane's center.
		const [headMercX] = lngLatToMercator(-71.5, 40);
		expect(maxLonMerc).toBeLessThan(headMercX);
		const pulledBack = headMercX - pullbackM * mercatorPerMeter(40);
		expect(maxLonMerc).toBeCloseTo(pulledBack, 7); // float32 storage
	});

	it("freezes with the landing clamp and skips single-sample flights", () => {
		const landedT = T0 + 2 * 60_000 + 15_000;
		const landing = new Map([["AA1", landedT]]);
		const frozen = buildTrailTubes(buf(), landedT + 3_600_000, {
			displayPoints: 20, steps: 1, headOffsetM: 0, landing,
		});
		let maxLonMerc = -Infinity;
		for (let v = 0; v < frozen.vertexCount; v++) {
			maxLonMerc = Math.max(maxLonMerc, frozen.centers[v * 4]);
		}
		const [expectedX] = lngLatToMercator(-71.75, 40); // 15s past last sample
		expect(maxLonMerc).toBeCloseTo(expectedX, 7); // float32 storage

		const single: MotionBuffer = new Map();
		updateMotion(single, [{
			id: 9, flight: "solo", start_date: new Date(T0).toISOString(),
			lat: 40, lon: -74, alt_ft: 30_000,
		}]);
		expect(buildTrailTubes(single, T0, {
			displayPoints: 20, steps: 1, headOffsetM: 0,
		}).vertexCount).toBe(0);
	});
});

describe("buildTrackTube colors", () => {
	const S = (lon: number, phase: string): AltitudeSample => ({
		lat: 40, lon, alt_ft: 30000, utc: "2001-09-11T12:00:00Z", phase,
	});

	it("emits one vec3 color per vertex, keyed on each vertex's phase", () => {
		const tube = buildTrackTube([S(-1, "takeoff"), S(-2, "takeoff"), S(-3, "down")]);
		expect(tube.colors).toBeDefined();
		expect(tube.colors!.length).toBe(tube.vertexCount * 3);
		// takeoff green appears somewhere; down maroon appears somewhere.
		const [tr, tg, tb] = phaseColorRgb01("takeoff");
		const [dr, dg, db] = phaseColorRgb01("down");
		const colors = Array.from(tube.colors!);
		const has = (r: number, g: number, b: number) => {
			for (let i = 0; i < colors.length; i += 3) {
				if (Math.abs(colors[i] - r) < 1e-6 && Math.abs(colors[i + 1] - g) < 1e-6 && Math.abs(colors[i + 2] - b) < 1e-6) return true;
			}
			return false;
		};
		expect(has(tr, tg, tb)).toBe(true);
		expect(has(dr, dg, db)).toBe(true);
	});

	it("falls back to the default color for coarse phases", () => {
		const tube = buildTrackTube([S(-1, "cruise"), S(-2, "cruise")]);
		const [r, g, b] = phaseColorRgb01("cruise"); // default red
		expect(tube.colors![0]).toBeCloseTo(r);
		expect(tube.colors![1]).toBeCloseTo(g);
		expect(tube.colors![2]).toBeCloseTo(b);
	});
});

describe("trailFadeAt", () => {
	it("follows the stop table (fraction measured FROM the plane)", () => {
		expect(trailFadeAt(0)).toBe(1);
		expect(trailFadeAt(0.25)).toBe(1); // flat through 50%
		expect(trailFadeAt(0.5)).toBe(1);
		expect(trailFadeAt(0.6)).toBeCloseTo(0.75, 6); // midway 1 -> 0.5
		expect(trailFadeAt(0.7)).toBeCloseTo(0.5, 6);
		expect(trailFadeAt(0.75)).toBeCloseTo(0.375, 6);
		expect(trailFadeAt(0.8)).toBeCloseTo(0.25, 6);
		expect(trailFadeAt(0.9)).toBeCloseTo(0.1, 6);
		expect(trailFadeAt(0.95)).toBeCloseTo(0.05, 6);
		expect(trailFadeAt(1)).toBe(0);
	});

	it("clamps outside [0, 1]", () => {
		expect(trailFadeAt(-0.5)).toBe(1);
		expect(trailFadeAt(1.5)).toBe(0);
	});
});
