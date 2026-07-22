import { describe, expect, it } from "vitest";
import { PHASE_COLORS, phaseColorHex, phaseColorRgb01, phaseLineColorExpression } from "./flightPhases";

describe("flightPhases", () => {
	it("maps known phases and falls back to the track red", () => {
		expect(phaseColorHex("hijack")).toBe("#f9a825");
		expect(phaseColorHex("down")).toBe("#7f0000");
		expect(phaseColorHex("cruise")).toBe("#b22222"); // coarse phase → default
		expect(phaseColorHex(undefined)).toBe("#b22222");
	});

	it("converts to 0..1 RGB for WebGL", () => {
		const [r, g, b] = phaseColorRgb01("takeoff"); // #2e7d32
		expect(r).toBeCloseTo(0x2e / 255);
		expect(g).toBeCloseTo(0x7d / 255);
		expect(b).toBeCloseTo(0x32 / 255);
	});

	it("builds a match expression covering all 8 phases with a default", () => {
		const expr = phaseLineColorExpression() as unknown[];
		expect(expr[0]).toBe("match");
		for (const slug of Object.keys(PHASE_COLORS)) {
			expect(expr).toContain(slug);
		}
		expect(expr[expr.length - 1]).toBe("#b22222"); // default is last
	});
});
