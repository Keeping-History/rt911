import { describe, expect, it } from "vitest";
import { DEFAULT_PHASE_COLOR, PHASE_COLORS, phaseColorHex, phaseColorRgb01, phaseLineColorExpression, orderedTrackPhases, phaseLabel, phasePaletteFor } from "./flightPhases";

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
		// Outer node prefers a stamped per-feature color; the slug match is the
		// fallback for features that carry only a phase.
		const expr = phaseLineColorExpression() as unknown[];
		expect(expr[0]).toBe("coalesce");
		const match = expr[2] as unknown[];
		expect(match[0]).toBe("match");
		for (const slug of Object.keys(PHASE_COLORS)) {
			expect(match).toContain(slug);
		}
		expect(match[match.length - 1]).toBe("#b22222"); // default is last
	});
});

describe("phaseLabel", () => {
	it("maps known slugs to human labels and passes unknowns through", () => {
		expect(phaseLabel("course_change")).toBe("Course Change");
		expect(phaseLabel("hijack")).toBe("Hijack");
		expect(phaseLabel("mystery")).toBe("mystery");
	});

	it("ground phase has a neutral color and label distinct from the default", () => {
		expect(PHASE_COLORS.ground).toBeDefined();
		expect(PHASE_COLORS.ground).not.toBe(DEFAULT_PHASE_COLOR);
		expect(phaseLabel("ground")).toBe("On Ground");
	});

	it("labels the altitude-derived phases AF1's legend surfaces", () => {
		// AF1 has no curated phase ramp, so its legend renders climb/cruise
		// alongside ground/descent — unlabeled they showed as raw slugs.
		expect(phaseLabel("climb")).toBe("Climb");
		expect(phaseLabel("cruise")).toBe("Cruise");
	});
});

describe("phasePaletteFor / per-flight palettes", () => {
	it("gives the hijacked four the escalation ramp and everyone else normal ops", () => {
		expect(phasePaletteFor("AA11")).toBe("escalation");
		expect(phasePaletteFor("UA93")).toBe("escalation");
		expect(phasePaletteFor("AF1")).toBe("normal");
		expect(phasePaletteFor("GOFER06")).toBe("normal");
		expect(phasePaletteFor(undefined)).toBe("normal");
	});

	it("colors AF1's altitude-derived phases distinctly instead of all-red", () => {
		const p = phasePaletteFor("AF1");
		const climb = phaseColorHex("climb", p);
		const cruise = phaseColorHex("cruise", p);
		const descent = phaseColorHex("descent", p);
		const ground = phaseColorHex("ground", p);
		// The reported bug: all three fell through to the flat red.
		for (const c of [climb, cruise, descent]) {
			expect(c).not.toBe(DEFAULT_PHASE_COLOR);
		}
		expect(new Set([climb, cruise, descent, ground]).size).toBe(4);
	});

	it("reuses the escalation ramp's calm colors for the matching regimes", () => {
		const p = phasePaletteFor("AF1");
		expect(phaseColorHex("climb", p)).toBe(PHASE_COLORS.takeoff);
		expect(phaseColorHex("cruise", p)).toBe(PHASE_COLORS.artcc);
		expect(phaseColorHex("descent", p)).toBe(PHASE_COLORS.tracon);
		expect(phaseColorHex("ground", p)).toBe(PHASE_COLORS.ground);
	});

	it("keeps the crisis red for a hijacked flight's final dive", () => {
		// `descent` is the one slug both vocabularies use — it must stay the
		// escalation ramp's red for the notables while AF1's reads as approach.
		expect(phaseColorHex("descent", phasePaletteFor("AA11"))).toBe(PHASE_COLORS.descent);
		expect(phaseColorHex("descent", phasePaletteFor("AF1")))
			.not.toBe(PHASE_COLORS.descent);
	});

	it("defaults to the escalation ramp when no palette is given", () => {
		expect(phaseColorHex("descent")).toBe(PHASE_COLORS.descent);
		expect(phaseColorHex("hijack")).toBe(PHASE_COLORS.hijack);
	});

	it("prefers a stamped feature color in the 2D line expression", () => {
		const expr = phaseLineColorExpression() as unknown as unknown[];
		expect(expr[0]).toBe("coalesce");
		expect(expr[1]).toEqual(["get", "color"]);
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
