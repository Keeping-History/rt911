import { describe, expect, it } from "vitest";
import { PLANE_ICON_PX, PLANE_NOTABLE_ICON_PX, colorizeSvg } from "./flightIcons";

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
