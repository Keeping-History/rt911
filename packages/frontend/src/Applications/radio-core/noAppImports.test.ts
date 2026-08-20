// radio-core is the shared radio library — stationGrouping, the audio
// pipeline, the players and the stylesheet that RadioScanner, RadioTuner,
// PlaylistEditor, MarketWatch, Mobile and Providers/Playlist all build on.
//
// The whole point of lifting it out of `Applications/RadioScanner/` was to
// make the dependency arrow point ONE way: apps depend on radio-core, never
// the reverse. Nothing enforces that but this test. The moment a module here
// reaches back into a sibling app directory, radio-core stops being a library
// and becomes a cycle — and deleting the app it reaches into (the reason this
// directory exists) breaks every other consumer.
//
// Text-scan style mirrors Components/manifestDescription.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_DIR = __dirname;
const APPS_DIR = join(__dirname, "..");

function walkSources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			out.push(...walkSources(path));
		} else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
			out.push(path);
		}
	}
	return out;
}

// `from "x"`, side-effect `import "x"`, `import("x")`, `require("x")` and
// `vi.mock("x", …)` — every way a module here can name another module.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire|\bvi\.mock)\s*\(?\s*["']([^"']+)["']/g;

function relativeSpecifiers(source: string): string[] {
	return [...source.matchAll(SPECIFIER)]
		.map((m) => m[1])
		.filter((specifier) => specifier.startsWith("."));
}

/** Where a relative specifier lands, as an absolute path. */
function target(fromFile: string, specifier: string): string {
	return resolve(dirname(fromFile), specifier);
}

function isInside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir + sep);
}

describe("radio-core imports nothing from an app directory", () => {
	const sources = walkSources(CORE_DIR);

	it("finds the modules it is guarding", () => {
		// A refactor that moves radio-core should update this test, not
		// silently reduce it to a no-op over zero files.
		expect(sources.length).toBeGreaterThanOrEqual(30);
	});

	it("has no module reaching into a sibling Applications/ directory", () => {
		const violations = sources.flatMap((path) =>
			relativeSpecifiers(readFileSync(path, "utf8"))
				.filter((specifier) => {
					const to = target(path, specifier);
					// Inside radio-core is fine. Anywhere outside
					// Applications/ (Providers, lib, Components) is fine.
					// Landing in Applications/ but NOT in radio-core means a
					// sibling app — that is the inversion this guards.
					return isInside(to, APPS_DIR) && !isInside(to, CORE_DIR);
				})
				.map((specifier) => `${path.slice(APPS_DIR.length + 1)} -> ${specifier}`),
		);

		expect(violations).toEqual([]);
	});
});
