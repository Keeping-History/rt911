import { describe, expect, it, vi } from "vitest";
import {
	assembleDefinition,
	displayWallClockToUtcIso,
	editorReducer,
	expandSelections,
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
	it("renamed adopts the title without marking the document dirty", () => {
		const clean = initialEditorState({
			id: "p1", title: "Lesson", status: "draft", date_updated: null, user_created: "u1",
			definition: { version: 1, mode: "annotate", entries: [] },
		});

		const after = editorReducer(clean, { type: "renamed", title: "Lesson Two" });

		expect(after.title).toBe("Lesson Two");
		expect(after.dirty).toBe(false);
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

describe("addEntries select", () => {
	it("selects the last added entry when asked, so the Settings window can edit it", () => {
		const s0 = initialEditorState(record);
		const s1 = editorReducer(s0, {
			type: "addEntries",
			entries: [
				{ entry: { kind: "jump", at: "", to: "" } },
				{ entry: { kind: "browser", url: "http://", at: "" } },
			],
			select: true,
		});
		expect(s1.selectedUid).toBe(s1.entries[s1.entries.length - 1].uid);
	});

	it("leaves the selection alone without the flag", () => {
		const s0 = { ...initialEditorState(record), selectedUid: "e1" };
		const s1 = editorReducer(s0, {
			type: "addEntries",
			entries: [{ entry: { kind: "jump", at: "", to: "" } }],
		});
		expect(s1.selectedUid).toBe("e1");
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

describe("expandSelections", () => {
	const flightFile = (itemId: string) => ({
		id: `flight-${itemId}`, name: itemId, kind: "file" as const, fileType: "flight",
		meta: { app: "flights", itemId, departure: null, arrival: null },
	});
	const selectAll = (name: string, paths: string[][]) => ({
		volumeId: "rt911-archive", path: paths[0],
		entry: { id: `sa-${name}`, name, kind: "file" as const, fileType: "flight",
			meta: { selectAllPaths: paths } },
	});

	it("expands a Select All entry into the folder's files, skipping folders and the nested Select All", async () => {
		const listFolder = vi.fn(async () => [
			{ id: "sa", name: "Select All", kind: "file" as const, fileType: "flight",
				meta: { selectAllPaths: [["Flights", "American Airlines", "2001-09-11"]] } },
			{ id: "d", name: "sub", kind: "folder" as const },
			flightFile("AA11"),
			flightFile("AA77"),
		]);
		const out = await expandSelections(
			[selectAll("Select All", [["Flights", "American Airlines", "2001-09-11"]])],
			listFolder,
		);
		expect(out.map((e) => e.entry)).toEqual([
			{ kind: "media", app: "flights", itemId: "AA11" },
			{ kind: "media", app: "flights", itemId: "AA77" },
		]);
	});

	it("expands an airline-level entry across all its date folders, sequentially", async () => {
		const order: string[] = [];
		const listFolder = vi.fn(async (path: string[]) => {
			order.push(path[2]);
			return [flightFile(`AA-${path[2]}`)];
		});
		const paths = [
			["Flights", "American Airlines", "2001-09-11"],
			["Flights", "American Airlines", "2001-09-12"],
		];
		const out = await expandSelections([selectAll("All American Airlines Flights", paths)], listFolder);
		expect(order).toEqual(["2001-09-11", "2001-09-12"]);
		expect(out.map((e) => (e.entry as { itemId: string }).itemId)).toEqual([
			"AA-2001-09-11", "AA-2001-09-12",
		]);
	});

	it("dedupes media entries when Select All overlaps an individual selection", async () => {
		const listFolder = vi.fn(async () => [flightFile("AA11"), flightFile("AA77")]);
		const out = await expandSelections(
			[
				{ volumeId: "rt911-archive", path: ["Flights", "American Airlines", "2001-09-11"],
					entry: flightFile("AA11") },
				selectAll("Select All", [["Flights", "American Airlines", "2001-09-11"]]),
			],
			listFolder,
		);
		expect(out.map((e) => (e.entry as { itemId: string }).itemId)).toEqual(["AA11", "AA77"]);
	});

	it("passes plain selections through without calling the lister, preserving timelineMeta", async () => {
		const listFolder = vi.fn();
		const out = await expandSelections(
			[
				{ volumeId: "rt911-archive", path: ["News", "NYT"],
					entry: { id: "news-101", name: "Doc", kind: "file", fileType: "news-document",
						meta: { app: "news", itemId: "101", publishedAt: "2001-09-11T10:00:00Z" } } },
			],
			listFolder,
		);
		expect(listFolder).not.toHaveBeenCalled();
		expect(out[0].entry).toEqual({ kind: "media", app: "news", itemId: "101" });
		expect(out[0].timelineMeta).toEqual({ publishedAt: "2001-09-11T10:00:00Z" });
	});

	it("keeps other folders' items when one folder listing fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const listFolder = vi.fn(async (path: string[]) => {
			if (path[2] === "2001-09-11") throw new Error("directus down");
			return [flightFile(`AA-${path[2]}`)];
		});
		const out = await expandSelections(
			[selectAll("All American Airlines Flights", [
				["Flights", "American Airlines", "2001-09-11"],
				["Flights", "American Airlines", "2001-09-12"],
			])],
			listFolder,
		);
		expect(out.map((e) => (e.entry as { itemId: string }).itemId)).toEqual(["AA-2001-09-12"]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
