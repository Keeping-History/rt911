import { describe, expect, it } from "vitest";
import { cToF, degToCompass, hpaToInHg, kmToMiles, ktToMph } from "./weatherUnits";

describe("cToF", () => {
	it.each([
		[0, 32],
		[100, 212],
		[-40, -40],
		[21.1, 70],
		[-17.2, 1],
	])("cToF(%d) === %d", (c, f) => {
		expect(cToF(c)).toBeCloseTo(f, 1);
	});
});

describe("ktToMph", () => {
	it.each([
		[0, 0],
		[10, 12],
		[20, 23],
		[87, 100],
	])("ktToMph(%d) === %d", (kt, mph) => {
		expect(ktToMph(kt)).toBe(mph);
	});
});

describe("kmToMiles", () => {
	it.each([
		[0, 0],
		[1, 1],
		[16.09, 10],
		[24, 15],
	])("kmToMiles(%d) === %d", (km, mi) => {
		expect(kmToMiles(km)).toBe(mi);
	});
});

describe("degToCompass", () => {
	it.each([
		[0, "N"],
		[360, "N"],
		[45, "NE"],
		[90, "E"],
		[135, "SE"],
		[180, "S"],
		[225, "SW"],
		[270, "W"],
		[315, "NW"],
		[11, "N"], // just below the N/NNE boundary at 11.25
		[12, "NNE"], // just above it
	])("degToCompass(%d) === %s", (deg, point) => {
		expect(degToCompass(deg)).toBe(point);
	});
});

describe("hpaToInHg", () => {
	it.each([
		[1013.25, 29.92],
		[1000, 29.53],
		[1029.5, 30.4],
	])("hpaToInHg(%d) === %d", (hpa, inHg) => {
		expect(hpaToInHg(hpa)).toBeCloseTo(inHg, 2);
	});
});
