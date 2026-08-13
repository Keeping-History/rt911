import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatchMock = vi.fn();
// Captures each ClassicyWindow's onCloseFunc by window id, so tests can
// simulate the user clicking the window's real close box without needing to
// render classicy's actual chrome.
const windowCloseFns = vi.hoisted(() => ({ current: {} as Record<string, () => void> }));
// Captures the app menu so a test can invoke a menu item without rendering
// classicy's real menu bar.
const appMenus = vi.hoisted(() => ({ current: [] as MenuGroup[] }));
type MenuItem = { id?: string; title?: string; onClickFunc?: () => void };
type MenuGroup = { id?: string; title?: string; menuChildren?: MenuItem[] };
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({
		children,
		title,
		id,
		onCloseFunc,
		appMenu,
	}: {
		children?: React.ReactNode;
		title?: string;
		id?: string;
		onCloseFunc?: () => void;
		appMenu?: MenuGroup[];
	}) => {
		if (id && onCloseFunc) windowCloseFns.current[id] = onCloseFunc;
		if (appMenu) appMenus.current = appMenu;
		return <div data-testid={`window-${title}`}>{children}</div>;
	},
	useAppManagerDispatch: () => dispatchMock,
}));

const mockAuth = vi.hoisted(() => ({
	status: "anonymous" as string,
	user: null as { id: string } | null,
}));
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => mockAuth,
}));

const mainProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("./PlaylistEditorMain", () => ({
	PlaylistEditorMain: (props: Record<string, unknown>) => {
		mainProps.current = props;
		return <div data-testid="editor-main">{props.closeRequested ? "CLOSING" : "EDITING"}</div>;
	},
}));

const testRecord = {
	id: "p1", title: "Lesson", status: "draft", date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "restrict", entries: [] },
};
vi.mock("./PlaylistList", () => ({
	PlaylistList: ({ onOpen }: { onOpen: (r: unknown) => void }) => (
		<button onClick={() => onOpen(testRecord)}>Mock Open</button>
	),
}));

import { CONTROL_NO_PLAYLIST } from "./ControlPanel";
import { PlaylistEditor } from "./PlaylistEditor";

beforeEach(() => {
	mockAuth.status = "anonymous";
	mockAuth.user = null;
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	windowCloseFns.current = {};
	mainProps.current = null;
});

describe("PlaylistEditor gating", () => {
	it("shows the sign-in alert with a Quit button when anonymous", () => {
		render(<PlaylistEditor />);
		expect(screen.getByText("You must be signed in to create playlists.")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Quit" })).not.toBeNull();
		expect(screen.queryByText("My Playlists")).toBeNull();
	});

	it("dispatches a quit action when Quit is clicked", () => {
		render(<PlaylistEditor />);
		fireEvent.click(screen.getByRole("button", { name: "Quit" }));
		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({ app: expect.objectContaining({ id: "PlaylistEditor.app" }) }),
		);
	});

	it("renders neither alert nor editor while auth is loading", () => {
		mockAuth.status = "loading";
		render(<PlaylistEditor />);
		expect(screen.queryByText("You must be signed in to create playlists.")).toBeNull();
		expect(screen.queryByText("My Playlists")).toBeNull();
	});

	it("renders the editor when signed in", () => {
		mockAuth.status = "signedIn";
		mockAuth.user = { id: "u1" };
		render(<PlaylistEditor />);
		expect(screen.queryByText("You must be signed in to create playlists.")).toBeNull();
		// list view (PlaylistList, mocked below) is what's shown before a record is opened
		expect(screen.getByRole("button", { name: "Mock Open" })).not.toBeNull();
	});
});

describe("PlaylistEditor dirty-close", () => {
	beforeEach(() => {
		mockAuth.status = "signedIn";
		mockAuth.user = { id: "u1" };
	});

	it("quits directly on window close when no record is open (list view)", () => {
		render(<PlaylistEditor />);
		act(() => windowCloseFns.current.playlist_editor_main());
		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({ app: expect.objectContaining({ id: "PlaylistEditor.app" }) }),
		);
	});

	it("quits directly on window close when the open editor is clean (not dirty)", () => {
		render(<PlaylistEditor />);
		fireEvent.click(screen.getByRole("button", { name: "Mock Open" }));
		expect(mainProps.current?.closeRequested).toBe(false);

		act(() => windowCloseFns.current.playlist_editor_main());
		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({ app: expect.objectContaining({ id: "PlaylistEditor.app" }) }),
		);
	});

	it("shows the close-confirm strip (via closeRequested) instead of quitting when the editor is dirty", () => {
		render(<PlaylistEditor />);
		fireEvent.click(screen.getByRole("button", { name: "Mock Open" }));
		act(() => (mainProps.current?.onDirtyChange as (d: boolean) => void)(true));

		act(() => windowCloseFns.current.playlist_editor_main());
		expect(dispatchMock).not.toHaveBeenCalled();
		expect(mainProps.current?.closeRequested).toBe(true);
		expect(screen.getByText("CLOSING")).not.toBeNull();
	});

	it("onQuit (wired to the same quit as the File-menu Quit) dispatches when invoked from the strip", () => {
		render(<PlaylistEditor />);
		fireEvent.click(screen.getByRole("button", { name: "Mock Open" }));
		act(() => (mainProps.current?.onDirtyChange as (d: boolean) => void)(true));
		act(() => windowCloseFns.current.playlist_editor_main());

		act(() => (mainProps.current?.onQuit as () => void)());
		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({ app: expect.objectContaining({ id: "PlaylistEditor.app" }) }),
		);
	});

	it("Cancel (onCancelClose) returns to the editor without quitting", () => {
		render(<PlaylistEditor />);
		fireEvent.click(screen.getByRole("button", { name: "Mock Open" }));
		act(() => (mainProps.current?.onDirtyChange as (d: boolean) => void)(true));
		act(() => windowCloseFns.current.playlist_editor_main());
		expect(mainProps.current?.closeRequested).toBe(true);

		act(() => (mainProps.current?.onCancelClose as () => void)());
		expect(dispatchMock).not.toHaveBeenCalled();
		expect(mainProps.current?.closeRequested).toBe(false);
		expect(screen.getByText("EDITING")).not.toBeNull();
	});
});

describe("Control window", () => {
	const controlItem = () =>
		appMenus.current
			.find((g) => g.title === "Window")
			?.menuChildren?.find((i) => i.title === "Control");

	beforeEach(() => {
		mockAuth.status = "signedIn";
		mockAuth.user = { id: "u1" };
		appMenus.current = [];
	});

	it("is closed until the Window menu opens it", () => {
		render(<PlaylistEditor />);
		expect(screen.queryByTestId("window-Control")).toBeNull();

		const item = controlItem();
		expect(item).toBeTruthy();
		act(() => item?.onClickFunc?.());

		expect(screen.getByTestId("window-Control")).toBeTruthy();
	});

	it("closes again from its close box", () => {
		render(<PlaylistEditor />);
		act(() => controlItem()?.onClickFunc?.());
		expect(screen.getByTestId("window-Control")).toBeTruthy();

		act(() => windowCloseFns.current.playlist_editor_control?.());
		expect(screen.queryByTestId("window-Control")).toBeNull();
	});

	// With no playlist open there is nothing to address a command to, so the
	// panel says so rather than offering controls that would 400.
	it("has nothing to control before a playlist is opened", () => {
		render(<PlaylistEditor />);
		act(() => controlItem()?.onClickFunc?.());
		expect(screen.getByText(CONTROL_NO_PLAYLIST)).toBeTruthy();
	});
});
