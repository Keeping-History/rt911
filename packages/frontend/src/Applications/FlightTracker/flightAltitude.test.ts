import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { updateMotion, type MotionBuffer } from "./flightMotion";
import { altitudeFtAt, exaggeratedHeightM, kmPerPixel, plane3DTargetPx } from "./flightAltitude";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "DL404", start_date: "2001-09-11T13:00:00Z",
	lat: 40, lon: -74, alt_ft: 33_000, ...over,
});

function bufferWith(items: Partial<FlightPosition>[]): MotionBuffer {
	const buf: MotionBuffer = new Map();
	updateMotion(buf, items.map((o, i) => pos({ id: i + 1, ...o })));
	return buf;
}


describe("kmPerPixel", () => {
	it("halves per zoom level and shrinks with latitude", () => {
		expect(kmPerPixel(5, 0)).toBeCloseTo(kmPerPixel(4, 0) / 2, 6);
		expect(kmPerPixel(5, 60)).toBeLessThan(kmPerPixel(5, 0));
	});
});

describe("plane3DTargetPx", () => {
	it("grows the on-screen marker as you zoom in, clamped at both ends", () => {
		// 2px floor: hand-tuned (issue #245) so continental views stay airy —
		// solid 3D silhouettes carry far more ink than the 2D icons.
		expect(plane3DTargetPx(3)).toBe(2); // floor
		expect(plane3DTargetPx(7)).toBeGreaterThan(plane3DTargetPx(5));
		expect(plane3DTargetPx(13)).toBe(44); // ceiling
	});
});




describe("altitudeFtAt (glided altitude)", () => {
	const T0 = Date.parse("2001-09-11T13:00:00Z");

	it("continues the vertical rate past the last sample, clamped like position", () => {
		const buf = bufferWith([
			{ id: 1, alt_ft: 10_000, start_date: new Date(T0).toISOString() },
		]);
		updateMotion(buf, [pos({ id: 2, alt_ft: 12_000, start_date: new Date(T0 + 60_000).toISOString() })]);
		const m = buf.get("DL404")!;
		expect(altitudeFtAt(m, T0 + 60_000)).toBe(12_000); // at the sample
		expect(altitudeFtAt(m, T0 + 90_000)).toBeCloseTo(13_000, 6); // +30s at 2,000 ft/min
		// Holds at the 90s extrapolation clamp instead of climbing forever.
		expect(altitudeFtAt(m, T0 + 60_000 + 10 * 60_000)).toBeCloseTo(15_000, 6);
		expect(exaggeratedHeightM(10_000)).toBeCloseTo(30_480, 0); // 10× exaggeration
	});

	it("holds the current altitude for single-sample flights", () => {
		const buf = bufferWith([{ alt_ft: 31_000 }]);
		expect(altitudeFtAt(buf.get("DL404")!, Date.parse("2001-09-11T14:00:00Z"))).toBe(31_000);
	});
});
