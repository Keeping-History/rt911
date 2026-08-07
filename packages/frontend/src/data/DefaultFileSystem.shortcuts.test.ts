import { ClassicyFileSystemEntryFileType } from "classicy";
import { describe, expect, it } from "vitest";
import { DefaultFileSystem } from "./DefaultFileSystem";

const driveRoot = DefaultFileSystem["Macintosh HD"];

describe("CMS page shortcuts", () => {
	it.each([
		["Press Room", "/press"],
		["For Teachers", "/teachers"],
	])("puts %s at the drive root pointing at %s", (name, url) => {
		const entry = driveRoot[name];
		expect(entry).toBeDefined();
		expect(entry._type).toBe(ClassicyFileSystemEntryFileType.Shortcut);
		expect(entry._url).toBe(url);
		// A real tab, not the in-desktop viewer: these are present-day pages
		// meant to be read, printed and shared, and the desktop survives in
		// the original tab either way.
		expect(entry._openIn).toBe("browser-new");
		expect(typeof entry._icon).toBe("string");
	});
});
