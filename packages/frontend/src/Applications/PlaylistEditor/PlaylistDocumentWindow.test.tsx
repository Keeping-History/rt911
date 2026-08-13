import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassicyMenuItem } from "classicy";
import { PlaylistDocumentWindow } from "./PlaylistDocumentWindow";
import type { EditorState } from "./editorState";

const menus = vi.hoisted(() => ({ current: [] as ClassicyMenuItem[] }));
const closeFns = vi.hoisted(() => ({ current: {} as Record<string, () => void> }));
const dispatchMock = vi.fn();
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
	// `onClose` fires after EVERY button, not just a dismissing one — classicy
	// runs `(button.onClick?.(), onClose?.())`, and its published type says so:
	// "Called after any button is clicked (in addition to that button's
	// onClick)." A mock that only wires onClick cannot see a handler pair that
	// undoes itself, which is exactly the bug this file failed to catch once.
	ClassicyAlert: ({ label, buttons, defaultButtonId, onClose }: {
		label?: string; defaultButtonId?: string; onClose?: () => void;
		buttons?: { id: string; label: string; onClick?: () => void }[];
	}) => (
		<div data-testid="alert" data-default-button={defaultButtonId}>
			<p>{label}</p>
			{buttons?.map((b) => (
				<button
					key={b.id}
					onClick={() => {
						b.onClick?.();
						onClose?.();
					}}
				>
					{b.label}
				</button>
			))}
		</div>
	),
	useAppManagerDispatch: () => dispatchMock,
}));

const playlistApi = vi.hoisted(() => ({
	deletePlaylist: vi.fn(),
	duplicatePlaylist: vi.fn(),
	getPlaylist: vi.fn(),
	updatePlaylist: vi.fn(),
}));
vi.mock("../../Providers/Auth/playlistApi", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...playlistApi,
}));

vi.mock("./PlaylistEditorMain", () => ({
	PlaylistEditorMain: () => <div data-testid="body" />,
}));

const saveMock = vi.fn();
// Captures the hook's `onSaved` callback so a test can drive the save's SUCCESS
// path — which is where the close-after-save and list-refresh behavior lives.
const onSaved = vi.hoisted(() => ({ current: undefined as undefined | (() => void) }));
vi.mock("./useSavePlaylist", () => ({
	useSavePlaylist: (_state: unknown, saved: () => void) => {
		onSaved.current = saved;
		return {
			prompt: { kind: "none" }, save: saveMock, confirmSave: vi.fn(),
			dismiss: vi.fn(), saving: false,
		};
	},
}));

const APP = "PlaylistEditor.app";
const WIN = "playlist_doc_p1";

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1", title: "Lesson", mode: "annotate", status: "draft",
	entries: [], selectedUid: null, dirty: false, nextUid: 1, ...over,
});

const ctx = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));
const toggleClockLock = vi.fn().mockResolvedValue(undefined);
const closePlaylist = vi.fn();
const closePlaylistWindow = vi.fn();
const editMock = vi.fn();
const setDialogModeMock = vi.fn();
const refreshListMock = vi.fn();
const openPlaylistMock = vi.fn();
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
		closePlaylistWindow,
		toggleClockLock,
		dismissLockError: vi.fn(),
		openPlaylist: openPlaylistMock,
		setDialogMode: setDialogModeMock,
		dialogMode: null,
		openTicks: {},
		listVersion: 0,
		refreshList: refreshListMock,
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
		dispatchMock.mockClear();

		fireEvent.click(screen.getByRole("button", { name: "Don't Save" }));

		expect(saveMock).not.toHaveBeenCalled();
		// The prompt re-asserted the window, so this path owes the store a close —
		// which is what closePlaylistWindow (not bare closePlaylist) delivers.
		// PlaylistEditorProvider.test.tsx proves it dispatches ClassicyWindowClose.
		expect(closePlaylistWindow).toHaveBeenCalledWith("p1");
		expect(closePlaylist).not.toHaveBeenCalled();
	});

	// Classicy's close box sets `closed: true` BEFORE running onCloseFunc, so
	// the prompt would otherwise be asking about a document already off screen
	// — and Cancel would leave it invisible but open, reachable only from the
	// Window menu.
	it("re-asserts the window before prompting, so Cancel is a true no-op", () => {
		renderWindow({ dirty: true });
		dispatchMock.mockClear();

		act(() => closeFns.current.playlist_doc_p1?.());

		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyWindowOpen", app: { id: APP }, window: { id: WIN },
		});
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyWindowFocus", app: { id: APP }, window: { id: WIN },
		});

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(closePlaylist).not.toHaveBeenCalled();
		expect(closePlaylistWindow).not.toHaveBeenCalled();
		expect(dispatchMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "ClassicyWindowClose" }),
		);
		expect(screen.getByTestId("win-playlist_doc_p1")).not.toBeNull();
	});

	// Save from the close prompt must finish the close the user asked for — and
	// only on success, so a failed write leaves the document open. The trap this
	// guards is the alert's `onClose`, which classicy fires after EVERY button:
	// anything that disarms the close-after-save flag there also disarms the Save
	// that just armed it, and the document silently stays open.
	it("Save from the close prompt closes the document once the save succeeds", () => {
		renderWindow({ dirty: true });
		act(() => closeFns.current.playlist_doc_p1?.());
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(saveMock).toHaveBeenCalled();
		// Nothing closes until the write comes back.
		expect(closePlaylistWindow).not.toHaveBeenCalled();

		act(() => onSaved.current?.());

		// Both halves, via the shared provider helper: the React state AND the
		// window classicy would otherwise keep serving menus for.
		expect(closePlaylistWindow).toHaveBeenCalledWith("p1");
	});

	// Cancelling withdraws the close request, so the flag that would have
	// finished it has to go too. Reachable while a write is still in flight: ask
	// to close, choose Save, then — before the server answers — try to close
	// again and cancel. Without the disarm the resolving write closes the window
	// the user just decided to keep, and any later save inherits the same flag.
	it("Cancel withdraws a close whose Save is still in flight", () => {
		renderWindow({ dirty: true });
		act(() => closeFns.current.playlist_doc_p1?.());
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		// The write is away but has not come back: still dirty, still open.
		expect(saveMock).toHaveBeenCalled();
		expect(closePlaylistWindow).not.toHaveBeenCalled();

		// Second thoughts — close again, then cancel.
		act(() => closeFns.current.playlist_doc_p1?.());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		dispatchMock.mockClear();

		// The in-flight write now succeeds. It must not close anything.
		act(() => onSaved.current?.());

		expect(closePlaylist).not.toHaveBeenCalled();
		expect(closePlaylistWindow).not.toHaveBeenCalled();
		expect(dispatchMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "ClassicyWindowClose" }),
		);
		expect(screen.getByTestId("win-playlist_doc_p1")).not.toBeNull();
	});

	it("a save that was not closing anything leaves the document open", () => {
		renderWindow({ dirty: true });
		dispatchMock.mockClear();

		act(() => onSaved.current?.());

		expect(closePlaylist).not.toHaveBeenCalled();
		expect(closePlaylistWindow).not.toHaveBeenCalled();
		expect(refreshListMock).toHaveBeenCalled();
	});

	// Raising itself is how a document reopened from the list comes to the
	// front: ClassicyWindowOpen on an id the store already knows only clears
	// `closed`, it does not focus.
	it("raises its own window when it mounts", () => {
		renderWindow();

		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyWindowOpen", app: { id: APP }, window: { id: WIN },
		});
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyWindowFocus", app: { id: APP }, window: { id: WIN },
		});
	});

	describe("File > Delete…", () => {
		it("asks for confirmation before deleting, with Cancel as the default button", () => {
			renderWindow();
			act(() => item("file", "playlist_file_delete").onClickFunc?.());

			const alert = screen.getByTestId("alert");
			expect(alert.textContent).toContain('Delete "Lesson"? This cannot be undone.');
			// HIG: the SAFE button is default when the action risks data loss.
			expect(alert.dataset.defaultButton).toBe("cancel");
			expect(playlistApi.deletePlaylist).not.toHaveBeenCalled();
		});

		// Deleting discards the document outright, so asking whether to save it
		// first would be nonsense.
		it("does not raise the dirty-save prompt, even on a dirty document", () => {
			renderWindow({ dirty: true });
			act(() => item("file", "playlist_file_delete").onClickFunc?.());

			const alert = screen.getByTestId("alert");
			expect(alert.textContent).toContain("This cannot be undone.");
			expect(alert.textContent).not.toContain("Save changes");
			expect(saveMock).not.toHaveBeenCalled();
		});

		it("Cancel deletes nothing and leaves the document open", () => {
			renderWindow();
			act(() => item("file", "playlist_file_delete").onClickFunc?.());

			fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

			expect(playlistApi.deletePlaylist).not.toHaveBeenCalled();
			expect(closePlaylistWindow).not.toHaveBeenCalled();
		});

		// Unmounting alone would leave the store holding a focused entry for the
		// deleted document, and the menu bar would keep serving its File menu —
		// so this path owes the store a close, not just React.
		it("closes its own window, not just its editor state", async () => {
			playlistApi.deletePlaylist.mockResolvedValue(undefined);
			renderWindow();
			act(() => item("file", "playlist_file_delete").onClickFunc?.());

			fireEvent.click(screen.getByRole("button", { name: "Delete" }));

			await waitFor(() => expect(closePlaylistWindow).toHaveBeenCalledWith("p1"));
			expect(playlistApi.deletePlaylist).toHaveBeenCalledWith("p1");
			expect(closePlaylist).not.toHaveBeenCalled();
			expect(refreshListMock).toHaveBeenCalled();
		});
	});

	it("File > Duplicate opens the copy in its own window and refreshes the list", async () => {
		const copy = {
			id: "p1-copy", title: "Lesson copy", status: "draft", date_updated: null,
			user_created: "u1", definition: { version: 1, mode: "annotate", entries: [] },
		};
		playlistApi.duplicatePlaylist.mockResolvedValue({ id: "p1-copy" });
		playlistApi.getPlaylist.mockResolvedValue(copy);
		renderWindow();

		act(() => item("file", "playlist_file_duplicate").onClickFunc?.());

		await waitFor(() => expect(openPlaylistMock).toHaveBeenCalledWith(copy));
		expect(playlistApi.duplicatePlaylist).toHaveBeenCalledWith("p1");
		expect(refreshListMock).toHaveBeenCalled();
	});

	it("a successful rename refreshes the list window", async () => {
		playlistApi.updatePlaylist.mockResolvedValue(undefined);
		renderWindow();
		act(() => item("file", "playlist_file_rename").onClickFunc?.());

		fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));

		await waitFor(() =>
			expect(editMock).toHaveBeenCalledWith("p1", { type: "renamed", title: "Renamed" }),
		);
		expect(playlistApi.updatePlaylist).toHaveBeenCalledWith("p1", { title: "Renamed" });
		expect(refreshListMock).toHaveBeenCalled();
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

	// Not reachable from PlaylistEditorProvider today — it batches `openIds`
	// and `states` together in the same callback, so a mounted playlistId
	// always has a matching state entry. But nothing enforces that from this
	// component's side, so it must survive `states` lacking this window's
	// entry rather than throwing out of the appMenu memo.
	it("returns null rather than throwing when this window's state hasn't landed yet", () => {
		ctx.current = {
			states: {},
			openIds: [],
			activeId: null,
			locks: {},
			lockError: null,
			edit: editMock,
			setActive: vi.fn(),
			closePlaylist,
		closePlaylistWindow,
			toggleClockLock,
			dismissLockError: vi.fn(),
			openPlaylist: openPlaylistMock,
			setDialogMode: setDialogModeMock,
			dialogMode: null,
			openTicks: {},
			listVersion: 0,
			refreshList: refreshListMock,
		};

		// If the appMenu memo dereferences `state` without guarding it, this
		// `render` call throws synchronously — a plain TypeError, not a
		// graceful null — and the test fails right here rather than at the
		// assertions below.
		const { container } = render(
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

		expect(container.firstChild).toBeNull();
		expect(screen.queryByTestId("win-playlist_doc_p1")).toBeNull();
	});
});
