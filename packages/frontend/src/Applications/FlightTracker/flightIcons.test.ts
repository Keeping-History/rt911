import { describe, expect, it } from "vitest";
import {
	PLANE_ICON_PX,
	PLANE_NOTABLE_ICON_PX,
	colorizeSvg,
	FAMILY_ICON_PX,
	familyIconId,
	familyIconPx,
	familyNotableIconId,
	familyNotableIconPx,
} from "./flightIcons";
import type { AircraftFamily } from "./aircraftModels";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M1 1"/></svg>';

describe("colorizeSvg", () => {
	it("injects the fill on the root element, borderless, art untouched", () => {
		const out = colorizeSvg(SVG, "#3a3a3a");
		expect(out).toContain('fill="#3a3a3a"');
		expect(out).not.toContain("stroke"); // no border on the glyph
		expect(out).toContain('<path d="M1 1"/>'); // art untouched
		expect(out.match(/fill=/g)).toHaveLength(1); // injected exactly once
	});
});

describe("icon sizes", () => {
	it("display sizes match the spec (12 regular / 32 notable)", () => {
		expect(PLANE_ICON_PX).toBe(12);
		expect(PLANE_NOTABLE_ICON_PX).toBe(32);
	});
});

describe("family icon sizing and ids", () => {
	it("has a size for every aircraft family, within the 9-16px band", () => {
		const families: AircraftFamily[] = [
			"generic", "b737", "b757", "b767", "b777", "b727", "md80",
			"dc10", "a319", "a320", "crj", "erj", "atr", "bizjet", "dc3",
		];
		for (const f of families) {
			expect(FAMILY_ICON_PX[f], f).toBeGreaterThanOrEqual(9);
			expect(FAMILY_ICON_PX[f], f).toBeLessThanOrEqual(16);
		}
		expect(Object.keys(FAMILY_ICON_PX)).toHaveLength(families.length);
	});

	it("keeps generic at the legacy 12px slot", () => {
		expect(FAMILY_ICON_PX.generic).toBe(PLANE_ICON_PX);
	});

	it("orders sizes by real aircraft size", () => {
		expect(FAMILY_ICON_PX.b777).toBeGreaterThan(FAMILY_ICON_PX.b757);
		expect(FAMILY_ICON_PX.b757).toBeGreaterThan(FAMILY_ICON_PX.crj);
	});

	it("builds image ids from the family", () => {
		expect(familyIconId("b767")).toBe("plane-b767");
		expect(familyNotableIconId("b767")).toBe("plane-notable-b767");
	});

	it("scales notable px proportionally around the 32px slot", () => {
		// b767 is 15px regular -> round(32 * 15 / 12) = 40
		expect(familyNotableIconPx("b767")).toBe(40);
		expect(familyNotableIconPx("generic")).toBe(PLANE_NOTABLE_ICON_PX);
	});

	it("falls back to the generic sizes for unknown families", () => {
		expect(familyIconPx("nonsense")).toBe(PLANE_ICON_PX);
		expect(familyNotableIconPx("nonsense")).toBe(PLANE_NOTABLE_ICON_PX);
	});
});
