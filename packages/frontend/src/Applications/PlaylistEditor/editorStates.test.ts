import { describe, expect, it } from "vitest";
import { editorStatesReducer, type EditorStates } from "./editorStates";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";

const rec = (id: string, title = "Lesson"): PlaylistRecord => ({
	id,
	title,
	status: "draft",
	date_updated: null,
	user_created: "u1",
	definition: { version: 1, mode: "annotate", entries: [] },
});

const opened = (...ids: string[]): EditorStates =>
	ids.reduce<EditorStates>(
		(acc, id) => editorStatesReducer(acc, { kind: "open", record: rec(id) }),
		{},
	);

describe("editorStatesReducer", () => {
	it("opens a playlist into its own slot", () => {
		const states = opened("p1");
		expect(Object.keys(states)).toEqual(["p1"]);
		expect(states.p1.title).toBe("Lesson");
		expect(states.p1.dirty).toBe(false);
	});

	// Reopening from the list must not silently throw away unsaved edits.
	it("leaves an already-open playlist untouched when reopened", () => {
		const dirty = editorStatesReducer(opened("p1"), {
			kind: "edit",
			playlistId: "p1",
			action: { type: "setTitle", title: "Edited" },
		});

		const reopened = editorStatesReducer(dirty, { kind: "open", record: rec("p1") });

		expect(reopened).toBe(dirty);
		expect(reopened.p1.title).toBe("Edited");
	});

	it("routes an edit to one playlist and leaves the others identical", () => {
		const before = opened("p1", "p2");

		const after = editorStatesReducer(before, {
			kind: "edit",
			playlistId: "p1",
			action: { type: "setTitle", title: "Edited" },
		});

		expect(after.p1.title).toBe("Edited");
		expect(after.p1.dirty).toBe(true);
		// Reference equality, not just deep equality: an untouched document must
		// not re-render because a sibling changed.
		expect(after.p2).toBe(before.p2);
	});

	it("ignores an edit aimed at a playlist that is not open", () => {
		const before = opened("p1");
		const after = editorStatesReducer(before, {
			kind: "edit",
			playlistId: "ghost",
			action: { type: "setTitle", title: "Nope" },
		});
		expect(after).toBe(before);
	});

	it("drops a playlist on close and leaves the rest identical", () => {
		const before = opened("p1", "p2");
		const after = editorStatesReducer(before, { kind: "close", playlistId: "p1" });

		expect(Object.keys(after)).toEqual(["p2"]);
		expect(after.p2).toBe(before.p2);
	});

	it("ignores closing a playlist that is not open", () => {
		const before = opened("p1");
		expect(editorStatesReducer(before, { kind: "close", playlistId: "ghost" })).toBe(before);
	});
});
