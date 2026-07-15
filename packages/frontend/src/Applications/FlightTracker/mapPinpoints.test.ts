import { describe, expect, it } from "vitest";
import { PINPOINTS, pinpointById } from "./mapPinpoints";

describe("mapPinpoints", () => {
	it("lists the six notable places with unique ids", () => {
		expect(PINPOINTS).toHaveLength(6);
		expect(new Set(PINPOINTS.map((p) => p.id)).size).toBe(6);
		expect(PINPOINTS.map((p) => p.label)).toEqual([
			"Boston Logan",
			"Newark International",
			"Washington Dulles",
			"NYC Financial District",
			"The Pentagon",
			"Shanksville, PA",
		]);
	});

	it("every center is inside the continental-US flight box, [lon, lat] order", () => {
		for (const p of PINPOINTS) {
			const [lon, lat] = p.center;
			expect(lon).toBeGreaterThan(-150);
			expect(lon).toBeLessThan(-65);
			expect(lat).toBeGreaterThan(18);
			expect(lat).toBeLessThan(65);
			expect(p.zoom).toBeGreaterThan(0);
		}
	});

	it("pinpointById round-trips and misses safely", () => {
		expect(pinpointById("pentagon")?.center).toEqual([-77.0563, 38.8719]);
		expect(pinpointById("nowhere")).toBeUndefined();
	});
});
