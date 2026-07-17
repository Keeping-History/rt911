import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ClassicyFileSystemEntryFileType, validateStack } from "classicy";
import { describe, expect, it } from "vitest";
import { DefaultFileSystem } from "./DefaultFileSystem";

// The Finder routes Stack-type files to HyperCard, which fetches the entry's
// _url and validates it at open time. These tests catch the failure modes a
// user would hit on double-click: a missing/renamed public file, an entry
// whose metadata drifted from the file, or a stack that no longer validates.
describe("Getting Started.stack", () => {
	const entry = DefaultFileSystem["Macintosh HD"]["Getting Started.stack"];
	const publicPath = resolve(
		__dirname,
		"../../public/stacks/getting-started.stack.json",
	);

	it("sits at the Macintosh HD root as a Stack-type file", () => {
		expect(entry).toBeDefined();
		expect(entry._type).toBe(ClassicyFileSystemEntryFileType.Stack);
		expect(entry._url).toBe("/stacks/getting-started.stack.json");
	});

	it("points at a public file whose size matches the entry", () => {
		expect(statSync(publicPath).size).toBe(entry._size);
	});

	it("is a valid HyperCard stack", () => {
		const raw = JSON.parse(readFileSync(publicPath, "utf8"));
		const result = validateStack(raw);
		expect(result).toMatchObject({ ok: true });
		if (result.ok) {
			expect(result.stack.name).toBe("911realtime.org User Guide");
			expect(result.stack.cards.length).toBeGreaterThan(1);
		}
	});
});
