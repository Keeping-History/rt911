// The desktop offers two looks, and the whole mechanism is two side-effect
// imports in AppProviders.tsx: Classicy 3 registers no Appearance Package of
// its own, and importing one registers it. That makes the feature unusually
// fragile — an import with no bindings reads like dead code, so a tidy-up (or a
// bundler misconfigured for `sideEffects`) can drop it and the only symptom is
// a look quietly missing from the Appearance Manager.
//
// Text-scan style mirrors radio-core/noAppImports.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CLASSICY_DEFAULT_APPEARANCE_PACKAGE_ID,
	listClassicyAppearancePackages,
} from "@classicy/classicy";

// Imported exactly as AppProviders.tsx imports them, for the side effect.
import "@classicy/appearance-platinum";
import "@classicy/appearance-system7";

const APP_PROVIDERS = join(__dirname, "AppProviders.tsx");

describe("appearance packages", () => {
	it("registers both looks", () => {
		const ids = listClassicyAppearancePackages().map((p) => p.id);
		expect(ids).toContain("platinum");
		expect(ids).toContain("system7");
	});

	// Platinum is the product's own look; System 7 is an option a user opts
	// into. Registering a second package must not change what a first-time
	// visitor sees.
	it("leaves Platinum as what a fresh desktop draws", () => {
		expect(CLASSICY_DEFAULT_APPEARANCE_PACKAGE_ID).toBe("platinum");
	});

	it("is imported by the desktop's provider tree", () => {
		const src = readFileSync(APP_PROVIDERS, "utf8");
		expect(src).toContain('import "@classicy/appearance-platinum"');
		expect(src).toContain('import "@classicy/appearance-system7"');
	});

	// Upstream calls mixing Appearance Package versions unsupported: the two
	// share one screen-saver registration module and one Logo-saver image
	// registry, which diverge across versions. The lockfile is resolved from
	// these ranges, so keeping them identical is what keeps the install honest.
	it("pins both looks and the core to one version range", () => {
		const pkg = JSON.parse(
			readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
		) as { dependencies: Record<string, string> };
		const core = pkg.dependencies["@classicy/classicy"];
		expect(pkg.dependencies["@classicy/appearance-platinum"]).toBe(core);
		expect(pkg.dependencies["@classicy/appearance-system7"]).toBe(core);
	});
});
