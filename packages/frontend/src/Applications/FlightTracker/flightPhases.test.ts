import { describe, expect, it } from "vitest";
import { PHASE_COLORS, phaseColorHex, phaseColorRgb01, phaseLineColorExpression, orderedTrackPhases, phaseLabel } from "./flightPhases";

describe("flightPhases", () => {
	it("maps known phases and falls back to the track red", () => {
		expect(phaseColorHex("hijack")).toBe("#f9a825");
		expect(phaseColorHex("down")).toBe("#7f0000");
		expect(phaseColorHex("cruise")).toBe("#b22222"); // coarse phase → default
		expect(phaseColorHex(undefined)).toBe("#b22222");
		expect(phaseColorHex("")).toBe("#b22222"); // empty string → default, not ""
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

describe("phaseLabel", () => {
	it("maps known slugs to human labels and passes unknowns through", () => {
		expect(phaseLabel("course_change")).toBe("Course Change");
		expect(phaseLabel("hijack")).toBe("Hijack");
		expect(phaseLabel("mystery")).toBe("mystery");
	});
});

describe("orderedTrackPhases", () => {
	it("returns first-seen phases in track order, deduped, skipping blanks", () => {
		const pts = [
			{ phase: "takeoff" }, { phase: "takeoff" }, { phase: "hijack" },
			{}, { phase: "hijack" }, { phase: "descent" }, { phase: "takeoff" },
		];
		expect(orderedTrackPhases(pts)).toEqual(["takeoff", "hijack", "descent"]);
	});
	it("returns [] for empty or phaseless input", () => {
		expect(orderedTrackPhases([])).toEqual([]);
		expect(orderedTrackPhases([{}, {}])).toEqual([]);
	});
});
