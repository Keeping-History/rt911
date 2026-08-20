// Deliberately NO vi.mock("classicy"): the helper reads the real manifest
// registry, same as appManifests.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { registerApp } from "classicy";
import { describe, expect, it } from "vitest";
import { manifestDescription } from "./manifestDescription";

describe("manifestDescription", () => {
	it("returns the registered manifest's description", () => {
		registerApp({
			id: "FakeBalloon.app",
			description: "A fake app for this test.",
		});
		expect(manifestDescription("FakeBalloon.app")).toBe(
			"A fake app for this test.",
		);
	});

	it("returns undefined for an unregistered app", () => {
		expect(manifestDescription("NeverRegistered.app")).toBeUndefined();
	});
});

// --- Wiring enforcement -----------------------------------------------------
// Every <ClassicyApp> this repo renders must pass desktopIconBalloonHelp so
// its desktop shortcut carries a balloon describing the app's purpose —
// except `extension` apps, which are background-only and never draw an icon.
// Text-scan style mirrors Components/AboutApp/appWiring.test.tsx. The tag
// regex stops at the first ">", which is fine while ClassicyApp opening tags
// hold only simple props (no inline arrow functions).

const APPS_DIR = join(__dirname, "../Applications");

function walkTsx(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			out.push(...walkTsx(path));
		} else if (name.endsWith(".tsx") && !name.includes(".test.")) {
			out.push(path);
		}
	}
	return out;
}

describe("desktop shortcut balloon wiring", () => {
	const appTags = walkTsx(APPS_DIR)
		.flatMap((path) => {
			const source = readFileSync(path, "utf8");
			const tags = source.match(/<ClassicyApp[\s\S]*?>/g) ?? [];
			return tags.map((tag) => ({ path, tag }));
		});

	it("finds the ClassicyApp renders it is guarding", () => {
		// A refactor that moves the app roots should update this test, not
		// silently reduce it to a no-op.
		expect(appTags.length).toBeGreaterThanOrEqual(18);
	});

	it.each(appTags.map(({ path, tag }) => [path.slice(APPS_DIR.length + 1), tag]))(
		"%s passes desktopIconBalloonHelp (or is an extension)",
		(_rel, tag) => {
			const isExtension = /\bextension\b/.test(tag);
			if (isExtension) return;
			expect(tag).toMatch(/desktopIconBalloonHelp=/);
		},
	);
});
