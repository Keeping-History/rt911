import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorState } from "./editorState";
import { PlaylistEditorMain } from "./PlaylistEditorMain";

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	useClassicyFileSystem: () => ({ fs: {}, separator: ":", resolve: () => undefined }),
}));
vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({ sources: { video: [], audio: [] } }),
}));

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
});
