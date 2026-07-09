import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RADAR_CENTER,
	RADAR_FALLBACK_COLOR,
	RADAR_TRAIL_MAX_OPACITY,
	RADAR_TRAIL_SLICES,
	resolveCssColor,
	sweepAngleDeg,
	sweepLineGeoJSON,
	sweepTrailGeoJSON,
} from "./flightRadar";

// Mirror the module's mercator math to verify screen-circularity independently.
const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) =>
	(1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2)) / Math.PI) / 2;

const tipOf = (nowMs: number): [number, number] => {
	const line = sweepLineGeoJSON(nowMs);
	return line.geometry.coordinates[1] as [number, number];
};

describe("sweepAngleDeg", () => {
	it("derives the phase from the clock: 0 at t=0, 90° at 15s, wraps each minute", () => {
		expect(sweepAngleDeg(0)).toBe(0);
		expect(sweepAngleDeg(15_000)).toBe(90);
		expect(sweepAngleDeg(60_000)).toBe(0);
		expect(sweepAngleDeg(75_000)).toBe(90);
	});
});

describe("sweepLineGeoJSON", () => {
	it("starts at the radar center", () => {
		const line = sweepLineGeoJSON(0);
		expect(line.geometry.coordinates[0]).toEqual(RADAR_CENTER);
	});

	it("points due north at t=0 (same longitude, higher latitude)", () => {
		const tip = tipOf(0);
		expect(tip[0]).toBeCloseTo(RADAR_CENTER[0], 6);
		expect(tip[1]).toBeGreaterThan(RADAR_CENTER[1]);
	});

	it("points due east at t=15s (same latitude, greater longitude)", () => {
		const tip = tipOf(15_000);
		expect(tip[1]).toBeCloseTo(RADAR_CENTER[1], 6);
		expect(tip[0]).toBeGreaterThan(RADAR_CENTER[0]);
	});

	it("traces a screen circle: equal mercator distance at every angle", () => {
		const dist = (tip: [number, number]) =>
			Math.hypot(mercX(tip[0]) - mercX(RADAR_CENTER[0]), mercY(tip[1]) - mercY(RADAR_CENTER[1]));
		const d0 = dist(tipOf(0));
		expect(dist(tipOf(15_000))).toBeCloseTo(d0, 9);
		expect(dist(tipOf(37_500))).toBeCloseTo(d0, 9);
	});
});

describe("sweepTrailGeoJSON", () => {
	it("builds the full wedge: 12 closed triangle slices with strictly fading opacity", () => {
		const fc = sweepTrailGeoJSON(0);
		expect(fc.features).toHaveLength(RADAR_TRAIL_SLICES);
		let prev = Number.POSITIVE_INFINITY;
		for (const f of fc.features) {
			const ring = f.geometry.coordinates[0];
			expect(ring).toHaveLength(4); // center, two rim points, closed back to center
			expect(ring[0]).toEqual(ring[3]);
			const op = f.properties?.opacity as number;
			expect(op).toBeGreaterThan(0);
			expect(op).toBeLessThanOrEqual(RADAR_TRAIL_MAX_OPACITY);
			expect(op).toBeLessThan(prev);
			prev = op;
		}
	});
});

describe("resolveCssColor", () => {
	afterEach(() => vi.restoreAllMocks());

	it("falls back when the CSS var is unset (jsdom default)", () => {
		expect(resolveCssColor(document.body, "--color-system-04", RADAR_FALLBACK_COLOR)).toBe(
			RADAR_FALLBACK_COLOR,
		);
	});

	it("returns the trimmed resolved value when present", () => {
		vi.spyOn(window, "getComputedStyle").mockReturnValue({
			getPropertyValue: () => " #abcdef ",
		} as unknown as CSSStyleDeclaration);
		expect(resolveCssColor(document.body, "--color-system-04", RADAR_FALLBACK_COLOR)).toBe("#abcdef");
	});
});
