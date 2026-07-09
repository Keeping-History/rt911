import { describe, expect, it } from "vitest";
import { PLANE_ICON_PX, PLANE_NOTABLE_ICON_PX, colorizeSvg } from "./flightIcons";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M1 1"/></svg>';

describe("colorizeSvg", () => {
	it("injects fill, white contrast stroke, and paint-order on the root element", () => {
		const out = colorizeSvg(SVG, "#3a3a3a");
		expect(out).toContain('fill="#3a3a3a"');
		expect(out).toContain('stroke="#ffffff"');
		expect(out).toContain('stroke-width="20"');
		expect(out).toContain('paint-order="stroke"');
		expect(out).toContain('<path d="M1 1"/>'); // art untouched
		expect(out.match(/fill=/g)).toHaveLength(1); // injected exactly once
	});
});

describe("icon sizes", () => {
	it("display sizes match the spec (24 regular / 32 notable)", () => {
		expect(PLANE_ICON_PX).toBe(24);
		expect(PLANE_NOTABLE_ICON_PX).toBe(32);
	});
});
