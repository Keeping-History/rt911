import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorState } from "./editorState";
import { PlaylistEditorMain } from "./PlaylistEditorMain";

afterEach(cleanup);

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1", title: "Lesson", mode: "annotate", status: "draft",
	entries: [], selectedUid: null, dirty: false, nextUid: 1, ...over,
});

describe("PlaylistEditorMain", () => {
	// The header and add bar moved to the menu bar and the Tools palette; the
	// body must not reintroduce chrome above the entry tree.
	it("renders no title field, mode radios, status picker, or Add buttons", () => {
		render(<PlaylistEditorMain state={state()} edit={vi.fn()} />);

		expect(screen.queryByLabelText("Title")).toBeNull();
		expect(screen.queryByLabelText("Status")).toBeNull();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("lists entries grouped by kind", () => {
		render(
			<PlaylistEditorMain
				state={state({
					entries: [{ uid: "e1", entry: { kind: "browser", url: "http://example.com", at: "" } }],
				})}
				edit={vi.fn()}
			/>,
		);

		expect(screen.getByText("Browser")).not.toBeNull();
		expect(screen.getByText(/example\.com/)).not.toBeNull();
	});

	it("routes an entry removal through the injected dispatcher", async () => {
		const edit = vi.fn();
		render(
			<PlaylistEditorMain
				state={state({ entries: [{ uid: "e1", entry: { kind: "jump", at: "", to: "" } }] })}
				edit={edit}
			/>,
		);

		screen.getByRole("button", { name: "Remove" }).click();

		expect(edit).toHaveBeenCalledWith("p1", { type: "removeEntry", uid: "e1" });
	});

	it("Edit selects the entry and reveals the Settings window", () => {
		const edit = vi.fn();
		const openSettings = vi.fn();
		render(
			<PlaylistEditorMain
				state={state({
					entries: [{ uid: "e1", entry: { kind: "browser", url: "http://example.com", at: "" } }],
				})}
				edit={edit}
				openSettings={openSettings}
			/>,
		);

		screen.getByRole("button", { name: "Edit" }).click();

		expect(edit).toHaveBeenCalledWith("p1", { type: "select", uid: "e1" });
		expect(openSettings).toHaveBeenCalled();
	});

	// Entry editing moved to the shared Settings utility window
	// (SettingsWindow.tsx); the document body must not render a second form
	// for the selection.
	it("renders no inline EntryForm even when an entry is selected", () => {
		const entries: EditorState["entries"] = [
			{ uid: "e1", entry: { kind: "browser", url: "http://example.com", at: "" } },
		];

		render(<PlaylistEditorMain state={state({ entries, selectedUid: "e1" })} edit={vi.fn()} />);
		expect(screen.queryByLabelText("URL")).toBeNull();
	});
});
