import { describe, expect, it } from "vitest";
import {
	PLANE_ICON_PX,
	PLANE_NOTABLE_ICON_PX,
	PIXEL_ALPHA_THRESHOLD,
	PIXEL_GRID_MIN,
	colorizeSvg,
	iconDisplayPx,
	FAMILY_ICON_PX,
	familyIconId,
	familyIconPx,
	familyNotableIconId,
	familyNotableIconPx,
	pixelGrid,
	snapAlpha,
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

describe("pixelGrid", () => {
	it("stays coarse enough to read as blocks at every family size", () => {
		// Every regular family size rasterizes at 2x, so a grid of N over
		// displayPx*2 device px gives blocks of (displayPx*2)/N. Below ~2
		// device px the blocks stop being visible and it just looks blurry.
		for (const px of Object.values(FAMILY_ICON_PX)) {
			expect((px * 2) / pixelGrid(px), `${px}px`).toBeGreaterThanOrEqual(2);
		}
	});

	it("clamps to the 8-16 sprite band", () => {
		expect(pixelGrid(1)).toBe(8); // floor: never fewer than 8 blocks
		expect(pixelGrid(9)).toBeGreaterThanOrEqual(8);
		expect(pixelGrid(999)).toBe(16); // cap: a 16x16 sprite is the ceiling
	});

	it("gives bigger icons more blocks, not bigger blocks forever", () => {
		expect(pixelGrid(PLANE_NOTABLE_ICON_PX)).toBeGreaterThan(pixelGrid(PLANE_ICON_PX));
	});
});

describe("iconDisplayPx", () => {
	it("leaves sizes untouched outside radar mode", () => {
		for (const px of Object.values(FAMILY_ICON_PX)) {
			expect(iconDisplayPx(px, false)).toBe(px);
		}
	});

	it("buys the small families real grid cells in radar mode", () => {
		// The whole point of the scale-up: at grid 8 a silhouette is a blob.
		// Every family must clear that floor once scaled.
		for (const px of Object.values(FAMILY_ICON_PX)) {
			expect(pixelGrid(iconDisplayPx(px, true)), `${px}px`).toBeGreaterThan(PIXEL_GRID_MIN);
		}
	});

	it("keeps regular icons smaller than notables, so the hierarchy survives", () => {
		// Notables are NOT scaled — they already sit at the grid cap. A regular
		// plane that outgrew them would break the highlight read.
		const biggest = Math.max(...Object.values(FAMILY_ICON_PX));
		expect(iconDisplayPx(biggest, true)).toBeLessThan(PLANE_NOTABLE_ICON_PX);
	});
});

describe("snapAlpha", () => {
	// Downsampling antialiases, so the small grid arrives with soft gray edge
	// pixels. 8-bit art has hard alpha: every pixel is fully in or fully out.
	const rgba = (...px: number[][]) => new Uint8ClampedArray(px.flat());

	it("drives every pixel to fully opaque or fully clear", () => {
		const data = rgba([255, 0, 0, 0], [255, 0, 0, 90], [255, 0, 0, 200], [255, 0, 0, 255]);
		snapAlpha(data, PIXEL_ALPHA_THRESHOLD);
		expect([...data].filter((_, i) => i % 4 === 3)).toEqual([0, 0, 255, 255]);
	});

	it("leaves color channels alone (getImageData is non-premultiplied)", () => {
		const data = rgba([12, 34, 56, 200]);
		snapAlpha(data, PIXEL_ALPHA_THRESHOLD);
		expect([...data].slice(0, 3)).toEqual([12, 34, 56]);
	});

	it("keeps thin swept wings: a low threshold preserves faint coverage", () => {
		// A wingtip that only half-covers its cell lands near a=128. Threshold
		// must sit below that or wide-body wings vanish in radar mode.
		expect(PIXEL_ALPHA_THRESHOLD).toBeLessThan(128);
		const wingtip = rgba([255, 255, 255, 128]);
		snapAlpha(wingtip, PIXEL_ALPHA_THRESHOLD);
		expect(wingtip[3]).toBe(255);
	});
});
