import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorState } from "./editorState";

const ctx = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./PlaylistEditorProvider", () => ({
	SETTINGS_WINDOW_ID: "playlist_editor_settings",
	usePlaylistEditor: () => ctx.current,
}));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children, id }: { children?: React.ReactNode; id?: string }) => (
		<div data-testid={`win-${id}`}>{children}</div>
	),
}));

// Captures what the window feeds the form, without dragging the registry in.
const formProps = vi.hoisted(() => ({
	current: null as null | { value: unknown; onChange: (entry: unknown) => void },
}));
vi.mock("./EntryForm", () => ({
	EntryForm: (props: { value: unknown; onChange: (entry: unknown) => void }) => {
		formProps.current = props;
		return <div data-testid="entry-form" />;
	},
}));

import { SettingsWindow } from "./SettingsWindow";

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1", title: "Lesson", mode: "annotate", status: "draft",
	entries: [], selectedUid: null, dirty: false, nextUid: 1, ...over,
});

afterEach(() => {
	cleanup();
	formProps.current = null;
	vi.clearAllMocks();
});

const renderWindow = (over: Record<string, unknown>) => {
	ctx.current = { states: {}, activeId: null, edit: vi.fn(), ...over };
	return render(<SettingsWindow appId="PlaylistEditor.app" icon="i.png" appMenu={[]} />);
};

describe("SettingsWindow", () => {
	it("shows a hint while no entry is selected in the active document", () => {
		renderWindow({});
		expect(screen.getByText(/select an entry/i)).not.toBeNull();
		expect(screen.queryByTestId("entry-form")).toBeNull();
	});

	it("renders the form for the ACTIVE document's selected entry and routes edits to it", () => {
		const edit = vi.fn();
		const selected = { uid: "e2", entry: { kind: "jump" as const, at: "", to: "" } };
		renderWindow({
			states: {
				p1: state({ entries: [{ uid: "e9", entry: { kind: "jump", at: "", to: "" } }], selectedUid: "e9" }),
				p2: state({ playlistId: "p2", entries: [selected], selectedUid: "e2" }),
			},
			activeId: "p2",
			edit,
		});

		expect(screen.getByTestId("entry-form")).not.toBeNull();
		expect(formProps.current?.value).toBe(selected);

		const next = { kind: "jump", at: "2001-09-11T13:00:00.000Z", to: "" };
		formProps.current?.onChange(next);
		expect(edit).toHaveBeenCalledWith("p2", { type: "updateEntry", uid: "e2", entry: next });
	});

	it("falls back to the hint when the active document has no selection", () => {
		renderWindow({
			states: { p1: state({ entries: [{ uid: "e1", entry: { kind: "jump", at: "", to: "" } }] }) },
			activeId: "p1",
		});
		expect(screen.getByText(/select an entry/i)).not.toBeNull();
	});
});
