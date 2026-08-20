import { ClassicyFileSystemEntryFileType } from "classicy";
import { describe, expect, it } from "vitest";
import { DefaultFileSystem } from "./DefaultFileSystem";
import { PAGE_SHORTCUT_DISPOSITION, PAGE_SHORTCUTS } from "./pageShortcuts";

const driveRoot = DefaultFileSystem["Macintosh HD"];

describe("CMS page shortcuts", () => {
	// This proves the two surfaces (desktop icons in Desktop.tsx, Finder
	// drive-root entries here) derive from the same PAGE_SHORTCUTS list rather
	// than each carrying its own copy of name/url/disposition/icon that could
	// silently drift apart.
	it.each(PAGE_SHORTCUTS)(
		"puts $name at the drive root pointing at $url",
		({ name, url }) => {
			const entry = driveRoot[name];
			expect(entry).toBeDefined();
			expect(entry._type).toBe(ClassicyFileSystemEntryFileType.Shortcut);
			expect(entry._url).toBe(url);
			// A real tab, not the in-desktop viewer: these are present-day pages
			// meant to be read, printed and shared, and the desktop survives in
			// the original tab either way.
			expect(entry._openIn).toBe(PAGE_SHORTCUT_DISPOSITION);
			expect(typeof entry._icon).toBe("string");
		},
	);

	it("has no extra Shortcut entries at the drive root beyond PAGE_SHORTCUTS", () => {
		const expectedNames = new Set(PAGE_SHORTCUTS.map((s) => s.name));
		const actualShortcutNames = Object.entries(driveRoot)
			.filter(([, entry]) => entry?._type === ClassicyFileSystemEntryFileType.Shortcut)
			.map(([name]) => name);

		expect(new Set(actualShortcutNames)).toEqual(expectedNames);
	});
});
