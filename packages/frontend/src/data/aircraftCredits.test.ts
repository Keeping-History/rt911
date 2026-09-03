import { describe, expect, it } from "vitest";
import { AIRCRAFT_CREDITS, NYC_90S_HERO_CREDIT } from "./aircraftCredits";

describe("model credits", () => {
	it("carries every aircraft family in the hosted manifest", () => {
		expect(AIRCRAFT_CREDITS).toHaveLength(15);
	});

	it.each([...AIRCRAFT_CREDITS, NYC_90S_HERO_CREDIT])(
		"$model has author, license and an https source",
		(credit) => {
			expect(credit.model.trim().length).toBeGreaterThan(0);
			expect(credit.author.trim().length).toBeGreaterThan(0);
			expect(credit.license.trim().length).toBeGreaterThan(0);
			expect(new URL(credit.url).protocol).toBe("https:");
		},
	);

	it("credits rorovera201305 for the NYC 90s model under CC-BY", () => {
		expect(NYC_90S_HERO_CREDIT.author).toContain("rorovera201305");
		expect(NYC_90S_HERO_CREDIT.license).toContain("CC-BY");
	});

	it("has no duplicate models", () => {
		const models = AIRCRAFT_CREDITS.map((c) => c.model);
		expect(new Set(models).size).toBe(models.length);
	});
});
