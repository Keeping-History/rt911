import { describe, expect, it, vi } from "vitest";
import {
	assembleDefinition,
	displayWallClockToUtcIso,
	editorReducer,
	initialEditorState,
	selectionsToEntries,
	utcIsoToDisplayWallClock,
} from "./editorState";

const record = {
	id: "p1", title: "Lesson", status: "draft" as const, date_updated: null, user_created: "u1",
	definition: {
		version: 1, mode: "restrict",
		entries: [{ kind: "media", app: "tv", itemId: "ABC" }],
	},
};

describe("initialEditorState", () => {
	it("loads a valid definition into uid-keyed entries", () => {
		const s = initialEditorState(record);
		expect(s.entries).toHaveLength(1);
		expect(s.entries[0].uid).toBe("e1");
		expect(s.entries[0].entry).toMatchObject({ kind: "media", itemId: "ABC" });
		expect(s.dirty).toBe(false);
	});
	it("falls back to zero entries on a structurally invalid definition", () => {
		const s = initialEditorState({ ...record, definition: { nope: true } });
		expect(s.entries).toEqual([]);
	});
	it("warns to the console when parsePlaylist reports warnings, but keeps the valid entries", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const s = initialEditorState({
			...record,
			definition: {
				version: 1, mode: "restrict",
				entries: [
					{ kind: "media", app: "tv", itemId: "ABC" },
					{ kind: "media", app: "bogus", itemId: "bad" }, // invalid app -> dropped with a warning
				],
			},
		});
		expect(s.entries).toHaveLength(1);
		expect(warn).toHaveBeenCalledWith(
			"playlist-editor: definition warnings on load:",
			expect.arrayContaining([expect.stringMatching(/unknown app/i)]),
		);
		warn.mockRestore();
	});
});

describe("editorReducer", () => {
	const base = initialEditorState(record);
	it("addEntries appends with fresh uids and marks dirty", () => {
		const s = editorReducer(base, {
			type: "addEntries",
			entries: [{ entry: { kind: "media", app: "radio", itemId: "FDNY-Manhattan" } }],
		});
		expect(s.entries).toHaveLength(2);
		expect(s.entries[1].uid).toBe("e2");
		expect(s.dirty).toBe(true);
	});
	it("updateEntry replaces by uid", () => {
		const s = editorReducer(base, {
			type: "updateEntry", uid: "e1",
			entry: { kind: "media", app: "tv", itemId: "ABC", start: "2001-09-11T12:00:00.000Z" },
		});
		expect(s.entries[0].entry).toMatchObject({ start: "2001-09-11T12:00:00.000Z" });
		expect(s.dirty).toBe(true);
	});
	it("removeEntry drops by uid and clears a matching selection", () => {
		const selected = editorReducer(base, { type: "select", uid: "e1" });
		const s = editorReducer(selected, { type: "removeEntry", uid: "e1" });
		expect(s.entries).toEqual([]);
		expect(s.selectedUid).toBeNull();
	});
	it("markSaved clears dirty", () => {
		const dirty = editorReducer(base, { type: "setTitle", title: "New" });
		expect(dirty.dirty).toBe(true);
		expect(editorReducer(dirty, { type: "markSaved" }).dirty).toBe(false);
	});
});

describe("assembleDefinition", () => {
	it("strips editor-local fields", () => {
		const def = assembleDefinition(initialEditorState(record));
		expect(def).toEqual({
			version: 1, mode: "restrict",
			entries: [{ kind: "media", app: "tv", itemId: "ABC" }],
		});
	});
});

describe("timezone helpers", () => {
	it("round-trips a display wall clock through UTC ISO", () => {
		const iso = "2001-09-11T12:40:00.000Z"; // 08:40 EDT
		const wall = utcIsoToDisplayWallClock(iso);
		expect(wall.getHours()).toBe(8);
		expect(wall.getMinutes()).toBe(40);
		expect(displayWallClockToUtcIso(wall)).toBe(iso);
	});
});

describe("selectionsToEntries", () => {
	it("maps media meta to MediaEntry with timelineMeta", () => {
		const out = selectionsToEntries([
			{
				volumeId: "rt911-archive", path: ["News", "NYT"],
				entry: { id: "news-101", name: "Doc", kind: "file", fileType: "news-document",
					meta: { app: "news", itemId: "101", publishedAt: "2001-09-11T10:00:00Z" } },
			},
		]);
		expect(out[0].entry).toEqual({ kind: "media", app: "news", itemId: "101" });
		expect(out[0].timelineMeta).toEqual({ publishedAt: "2001-09-11T10:00:00Z" });
	});
	it("maps classicyPath meta to a FileEntry", () => {
		const out = selectionsToEntries([
			{
				volumeId: "fs-Macintosh HD", path: ["Documents"],
				entry: { id: "x", name: "WTC1.pdf", kind: "file", fileType: "pdf",
					meta: { classicyPath: "Macintosh HD:Documents:WTC1.pdf" } },
			},
		]);
		expect(out[0].entry).toEqual({ kind: "file", path: "Macintosh HD:Documents:WTC1.pdf", at: "" });
	});
});
