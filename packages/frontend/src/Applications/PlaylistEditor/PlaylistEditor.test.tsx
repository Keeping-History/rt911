import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassicyFileOpenSelection, ClassicyMenuItem } from "classicy";
import { PlaylistEditor } from "./PlaylistEditor";

const dispatchMock = vi.fn();
const windows = vi.hoisted(() => ({ current: {} as Record<string, { appMenu?: ClassicyMenuItem[] }> }));
// Captures ClassicyFileOpenDialog's props, the same way `windows` captures
// ClassicyWindow's appMenu — needed to invoke onOpenFunc and to observe
// whether the dialog closed (open flips false) without rendering classicy's
// real file-dialog chrome.
const fileOpenDialog = vi.hoisted(() => ({
	current: null as null | {
		open?: boolean;
		volumes?: { id: string; label: string }[];
		onOpenFunc?: (selections: ClassicyFileOpenSelection[]) => void;
	},
}));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({ children, id, appMenu }: {
		children?: React.ReactNode; id?: string; appMenu?: ClassicyMenuItem[];
	}) => {
		if (id) windows.current[id] = { appMenu };
		return <div data-testid={`win-${id}`}>{children}</div>;
	},
	ClassicyFileOpenDialog: (props: {
		open?: boolean;
		volumes?: { id: string; label: string }[];
		onOpenFunc?: (selections: ClassicyFileOpenSelection[]) => void;
	}) => {
		fileOpenDialog.current = props;
		return null;
	},
	useAppManagerDispatch: () => dispatchMock,
	useAppManager: () => false,
}));

const mockAuth = vi.hoisted(() => ({ status: "signedIn" as string, user: { id: "u1" } as { id: string } | null }));
vi.mock("../../Providers/Auth/AuthContext", () => ({ useAuth: () => mockAuth }));
// Mutable so the Select All test can hand the archive volume real channel
// lists; reset in afterEach.
const mediaSources = vi.hoisted(() => ({
	current: { video: [] as string[], audio: [] as string[] },
}));
vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({ sources: mediaSources.current }),
}));

const testRecord = {
	id: "p1", title: "Lesson", status: "draft", date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "annotate", entries: [] },
};
// A second record, opened only by the file-dialog test below, to prove a
// selection lands on whichever playlist is ACTIVE rather than the one that
// happened to open first.
const testRecord2 = {
	id: "p2", title: "Lesson Two", status: "draft", date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "annotate", entries: [] },
};
vi.mock("./PlaylistList", () => ({
	PlaylistList: ({ onOpen }: { onOpen: (r: unknown) => void }) => (
		<>
			<button onClick={() => onOpen(testRecord)}>Mock Open</button>
			<button onClick={() => onOpen(testRecord2)}>Mock Open 2</button>
		</>
	),
}));
// Captures each open document's `state.entries` by playlist id, so the
// file-dialog test can tell which document actually received the dispatched
// entry instead of just asserting *some* dispatch happened.
const mainEntries = vi.hoisted(() => ({ current: {} as Record<string, unknown[]> }));
vi.mock("./PlaylistEditorMain", () => ({
	PlaylistEditorMain: ({ state }: { state: { playlistId: string; entries: unknown[] } }) => {
		mainEntries.current[state.playlistId] = state.entries;
		return <div data-testid="body" />;
	},
}));

afterEach(() => {
	cleanup();
	windows.current = {};
	fileOpenDialog.current = null;
	mainEntries.current = {};
	mockAuth.status = "signedIn";
	mediaSources.current = { video: [], audio: [] };
	vi.clearAllMocks();
});

describe("PlaylistEditor", () => {
	it("shows the list and the Tools palette once signed in", () => {
		render(<PlaylistEditor />);
		expect(screen.getByTestId("win-playlist_editor_list")).not.toBeNull();
		expect(screen.getByTestId("win-playlist_editor_tools")).not.toBeNull();
	});

	it("shows only the gate while signed out — no list, no palette", () => {
		mockAuth.status = "anonymous";
		render(<PlaylistEditor />);

		expect(screen.getByTestId("win-playlist_editor_gate")).not.toBeNull();
		expect(screen.queryByTestId("win-playlist_editor_list")).toBeNull();
		expect(screen.queryByTestId("win-playlist_editor_tools")).toBeNull();
	});

	it("opens a playlist into its own window, keeping the list open", () => {
		render(<PlaylistEditor />);

		act(() => screen.getByRole("button", { name: "Mock Open" }).click());

		expect(screen.getByTestId("win-playlist_doc_p1")).not.toBeNull();
		expect(screen.getByTestId("win-playlist_editor_list")).not.toBeNull();
	});

	// The palette is the app's menu of last resort. Withholding `appMenu` once a
	// document opens does NOT make it menu-less to classicy — the focus reducer
	// falls back to the window's stored menuBar and the SetMenuBar effect never
	// clears it — so the bar would swap to a STALE palette menu. Supplying it
	// always keeps Quit reachable and the menu current. See design decision 9.
	it("always gives the palette a menu, document windows open or not", () => {
		render(<PlaylistEditor />);
		expect(windows.current.playlist_editor_tools.appMenu).toBeDefined();

		act(() => screen.getByRole("button", { name: "Mock Open" }).click());

		const palette = windows.current.playlist_editor_tools.appMenu;
		expect(palette).toBeDefined();
		expect(palette?.map((m) => m.id)).toEqual(["file", "window"]);
		// …and it is the CURRENT menu: the open document shows up in it.
		const windowMenu = palette?.find((m) => m.id === "window");
		expect(windowMenu?.menuChildren?.some((c) => c.id === "playlist_window_doc_p1")).toBe(true);
	});

	// The file-open dialog moved from PlaylistEditorMain (Task 8 stripped its
	// tests along with the component) up to app level in this file. Nothing
	// else in the plan exercises the wiring, so this proves a selection is
	// dispatched into the ACTIVE document — not the first-opened one, and not
	// silently dropped — and that the dialog closes afterwards.
	it("dispatches an opened selection to the active document and closes the dialog", async () => {
		render(<PlaylistEditor />);

		act(() => screen.getByRole("button", { name: "Mock Open" }).click()); // opens p1
		act(() => screen.getByRole("button", { name: "Mock Open 2" }).click()); // opens p2, focuses it

		act(() => fireEvent.click(screen.getByRole("button", { name: "Add Media…" })));
		expect(fileOpenDialog.current?.open).toBe(true);

		const selection: ClassicyFileOpenSelection = {
			volumeId: "archive",
			path: ["TV Channels"],
			entry: {
				id: "tv-CNN", name: "CNN", kind: "file",
				fileType: "tv-channel", meta: { app: "tv", itemId: "CNN" },
			},
		};
		// async: selection expansion (Select All support) resolves on a microtask
		await act(async () => fileOpenDialog.current?.onOpenFunc?.([selection]));

		expect(mainEntries.current.p2).toHaveLength(1);
		expect((mainEntries.current.p2[0] as { entry: unknown }).entry).toEqual({
			kind: "media", app: "tv", itemId: "CNN",
		});
		expect(mainEntries.current.p1 ?? []).toHaveLength(0);
		expect(fileOpenDialog.current?.open).toBe(false);
	});

	// Media entries only ever come from the archive — offering Desktop /
	// Macintosh HD there produced selections the playlist couldn't use.
	it("offers only the 9/11 Realtime Archive volume in the Add Media dialog", () => {
		render(<PlaylistEditor />);

		act(() => screen.getByRole("button", { name: "Mock Open" }).click());
		act(() => fireEvent.click(screen.getByRole("button", { name: "Add Media…" })));

		expect(fileOpenDialog.current?.open).toBe(true);
		expect(fileOpenDialog.current?.volumes?.map((v) => v.id)).toEqual(["rt911-archive"]);
		expect(fileOpenDialog.current?.volumes?.[0].label).toBe("9/11 Realtime Archive");
	});

	it("expands a Select All selection through the archive volume into the active document", async () => {
		mediaSources.current = { video: ["ABC", "CNN"], audio: [] };
		render(<PlaylistEditor />);

		act(() => screen.getByRole("button", { name: "Mock Open" }).click()); // opens p1
		act(() => fireEvent.click(screen.getByRole("button", { name: "Add Media…" })));

		const selectAll: ClassicyFileOpenSelection = {
			volumeId: "rt911-archive",
			path: ["TV Channels"],
			entry: {
				id: "select-all-tv", name: "Select All", kind: "file",
				fileType: "tv-channel", meta: { selectAllPaths: [["TV Channels"]] },
			},
		};
		await act(async () => fileOpenDialog.current?.onOpenFunc?.([selectAll]));

		// Both channels from the live sources list, with the volume's own nested
		// Select All entry filtered out of the expansion.
		expect(
			mainEntries.current.p1.map((e) => (e as { entry: { itemId: string } }).entry.itemId),
		).toEqual(["ABC", "CNN"]);
	});
});
