import { ClassicyFileSystemEntryFileType } from "classicy";
import { describe, expect, it } from "vitest";
import { DefaultFileSystem } from "./DefaultFileSystem";
import {
	GETTING_STARTED_FILE,
	GETTING_STARTED_NAME,
	GETTING_STARTED_PATH,
	STACK_DRIVE,
} from "./stackShortcuts";

describe("Getting Started desktop shortcut", () => {
	it("addresses a file that actually exists in the default tree", () => {
		// The whole failure mode this guards: the shortcut resolves a path, and a
		// path that resolves to nothing does nothing — no error, no window, no
		// clue. Renaming the Finder entry without the constant would do exactly
		// that.
		const entry = DefaultFileSystem[STACK_DRIVE][GETTING_STARTED_FILE];
		expect(entry).toBeDefined();
		expect(entry._type).toBe(ClassicyFileSystemEntryFileType.Stack);
	});

	it("builds a colon-separated path, not a slash-separated one", () => {
		// Classicy file-system paths follow the classic Mac convention and
		// ClassicyFileSystem.pathArray splits on ':'. A slash would be treated as
		// part of a single segment and resolve to nothing.
		expect(GETTING_STARTED_PATH).toBe(`${STACK_DRIVE}:${GETTING_STARTED_FILE}`);
		expect(GETTING_STARTED_PATH).not.toContain("/");
	});

	it("labels the icon without the file extension", () => {
		expect(GETTING_STARTED_NAME).toBe("Getting Started");
		expect(GETTING_STARTED_FILE).toBe(`${GETTING_STARTED_NAME}.stack`);
	});
});
