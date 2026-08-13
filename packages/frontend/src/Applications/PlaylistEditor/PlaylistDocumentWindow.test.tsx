import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassicyMenuItem } from "classicy";
import { PlaylistDocumentWindow } from "./PlaylistDocumentWindow";
import type { EditorState } from "./editorState";

const menus = vi.hoisted(() => ({ current: [] as ClassicyMenuItem[] }));
const closeFns = vi.hoisted(() => ({ current: {} as Record<string, () => void> }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children, id, appMenu, onCloseFunc, title }: {
		children?: React.ReactNode; id?: string; appMenu?: ClassicyMenuItem[];
		onCloseFunc?: () => void; title?: string;
	}) => {
		if (appMenu) menus.current = appMenu;
		if (id && onCloseFunc) closeFns.current[id] = onCloseFunc;
		return <div data-testid={`win-${id}`} data-title={title}>{children}</div>;
	},
	ClassicyAlert: ({ label, buttons }: {
		label?: string; buttons?: { id: string; label: string; onClick?: () => void }[];
	}) => (
		<div data-testid="alert">
			<p>{label}</p>
			{buttons?.map((b) => (
				<button key={b.id} onClick={b.onClick}>{b.label}</button>
			))}
		</div>
	),
}));

vi.mock("./PlaylistEditorMain", () => ({
	PlaylistEditorMain: () => <div data-testid="body" />,
}));

const saveMock = vi.fn();
vi.mock("./useSavePlaylist", () => ({
	useSavePlaylist: () => ({
		prompt: { kind: "none" }, save: saveMock, confirmSave: vi.fn(),
		dismiss: vi.fn(), saving: false,
	}),
}));

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1", title: "Lesson", mode: "annotate", status: "draft",
	entries: [], selectedUid: null, dirty: false, nextUid: 1, ...over,
});

const ctx = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));
const toggleClockLock = vi.fn().mockResolvedValue(undefined);
const closePlaylist = vi.fn();
const editMock = vi.fn();
const setDialogModeMock = vi.fn();
vi.mock("./PlaylistEditorProvider", () => ({
	usePlaylistEditor: () => ctx.current,
}));

const renderWindow = (over: Partial<EditorState> = {}) => {
	ctx.current = {
		states: { p1: state(over) },
		openIds: ["p1"],
		activeId: "p1",
		locks: { p1: { clock: false, busy: false } },
		lockError: null,
		edit: editMock,
		setActive: vi.fn(),
		closePlaylist,
		toggleClockLock,
		dismissLockError: vi.fn(),
		openPlaylist: vi.fn(),
		setDialogMode: setDialogModeMock,
		dialogMode: null,
	};
	return render(
		<PlaylistDocumentWindow
			playlistId="p1"
			index={0}
			appId="PlaylistEditor.app"
			appIcon="i.png"
			quitItem={{ id: "quit", title: "Quit" }}
			onFocusTools={vi.fn()}
			onFocusList={vi.fn()}
			onFocusDocument={vi.fn()}
			onOpenList={vi.fn()}
		/>,
	);
};

const menu = (id: string) => {
	const found = menus.current.find((m) => m.id === id);
	if (!found) throw new Error(`no ${id} menu`);
	return found;
};
const item = (menuId: string, itemId: string) => {
	const found = menu(menuId).menuChildren?.find((c) => c.id === itemId);
	if (!found) throw new Error(`no ${itemId}`);
	return found;
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PlaylistDocumentWindow", () => {
	it("titles the window with the playlist title", () => {
		renderWindow();
		expect(screen.getByTestId("win-playlist_doc_p1").dataset.title).toBe("Lesson");
	});

	it("carries File, Edit, Control, and Window menus", () => {
		renderWindow();
		expect(menus.current.map((m) => m.id)).toEqual(["file", "edit", "control", "window"]);
	});

	// The Control menu belongs to this window, so it must act on THIS
	// playlist — never on whichever document happens to be active.
	it("locks the clock for its own playlist", async () => {
		renderWindow();
		act(() => item("control", "playlist_control_clock").onClickFunc?.());
		await waitFor(() => expect(toggleClockLock).toHaveBeenCalledWith("p1"));
	});

	it("closes without a prompt when the document is clean", () => {
		renderWindow({ dirty: false });
		act(() => closeFns.current.playlist_doc_p1?.());
		expect(closePlaylist).toHaveBeenCalledWith("p1");
		expect(screen.queryByTestId("alert")).toBeNull();
	});

	it("asks before closing a dirty document, and does not close on its own", () => {
		renderWindow({ dirty: true });
		act(() => closeFns.current.playlist_doc_p1?.());

		expect(closePlaylist).not.toHaveBeenCalled();
		expect(screen.getByTestId("alert").textContent).toContain('Save changes to "Lesson" before closing?');
	});

	it("Don't Save closes the dirty document without writing", () => {
		renderWindow({ dirty: true });
		act(() => closeFns.current.playlist_doc_p1?.());

		screen.getByRole("button", { name: "Don't Save" }).click();

		expect(closePlaylist).toHaveBeenCalledWith("p1");
		expect(saveMock).not.toHaveBeenCalled();
	});

	// addMenuItems (./playlistMenus) builds Edit > Add…'s children, and this
	// window is its first real consumer. ToolsPalette.test.tsx already
	// parametrizes over every ADD_ACTIONS entry for the floating palette, so
	// one representative action here is enough to prove the menu wiring
	// itself reaches THIS window's playlist id, not the active document.
	it("Edit > Add… dispatches for this window's playlist", () => {
		renderWindow();
		const addMenu = item("edit", "playlist_edit_add");
		const jumpItem = addMenu.menuChildren?.find((c) => c.id === "playlist_add_jump");
		if (!jumpItem) throw new Error("no playlist_add_jump");

		act(() => jumpItem.onClickFunc?.());

		expect(editMock).toHaveBeenCalledWith("p1", {
			type: "addEntries",
			entries: [{ entry: { kind: "jump", at: "", to: "" } }],
		});
	});
});
