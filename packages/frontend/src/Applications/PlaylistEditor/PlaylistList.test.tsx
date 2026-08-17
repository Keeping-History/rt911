import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
	listMine: vi.fn(),
	getPlaylist: vi.fn(),
	createPlaylist: vi.fn(),
	deletePlaylist: vi.fn(),
	duplicatePlaylist: vi.fn(),
}));
vi.mock("../../Providers/Auth/playlistApi", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...api,
}));

const mockAuth = vi.hoisted(() => ({
	status: "signedIn" as string,
	user: { id: "u1" } as { id: string } | null,
	signInWithEmail: vi.fn(),
	signInWithProvider: vi.fn(),
	signOut: vi.fn(),
	refresh: vi.fn(),
	register: vi.fn(),
}));
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => mockAuth,
}));

// The list lives inside PlaylistEditorProvider and now reaches it directly, to
// close a document window whose playlist it just deleted.
const editorCtx = vi.hoisted(() => ({
	openIds: [] as string[],
	closePlaylistWindow: vi.fn(),
}));
vi.mock("./PlaylistEditorProvider", () => ({
	usePlaylistEditor: () => editorCtx,
}));

import { PlaylistList } from "./PlaylistList";

// Midday UTC on purpose: the Modified column renders a real local timestamp,
// so a midnight fixture would land on the previous day in any negative-offset
// zone and make the assertions below timezone-dependent.
const rows = [
	{ id: "p1", title: "Lesson One", status: "draft", date_updated: "2026-07-16T12:00:00Z", user_created: "u1" },
	{ id: "p2", title: "Lesson Two", status: "published", date_updated: null, user_created: "u1" },
];

beforeEach(() => {
	api.listMine.mockResolvedValue(rows);
	mockAuth.refresh.mockResolvedValue(undefined);
	editorCtx.openIds = [];
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PlaylistList", () => {
	it("lists the teacher's playlists", async () => {
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		expect(await screen.findByText("Lesson One")).not.toBeNull();
		expect(screen.getByText("Lesson Two")).not.toBeNull();
		expect(api.listMine).toHaveBeenCalledWith("u1");
	});

	it("creates and opens a new playlist via New", async () => {
		const record = { id: "p3", title: "Untitled Playlist", status: "draft", definition: { version: 1, mode: "annotate", entries: [] }, date_updated: null, user_created: "u1" };
		api.createPlaylist.mockResolvedValue(record);
		const onOpen = vi.fn();
		render(<PlaylistList meId="u1" onOpen={onOpen} />);
		await screen.findByText("Lesson One");
		fireEvent.click(screen.getByRole("button", { name: "New" }));
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith(record));
		expect(api.createPlaylist).toHaveBeenCalledWith("Untitled Playlist", { version: 1, mode: "annotate", entries: [] });
	});

	it("opens the selected playlist", async () => {
		const record = { ...rows[0], definition: { version: 1, mode: "restrict", entries: [] } };
		api.getPlaylist.mockResolvedValue(record);
		const onOpen = vi.fn();
		render(<PlaylistList meId="u1" onOpen={onOpen} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith(record));
	});

	it("requires confirmation before delete, then refreshes", async () => {
		api.deletePlaylist.mockResolvedValue(undefined);
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(api.deletePlaylist).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete \"Lesson One\"" }));
		await waitFor(() => expect(api.deletePlaylist).toHaveBeenCalledWith("p1"));
		expect(api.listMine).toHaveBeenCalledTimes(2);
	});

	// New to the multi-window rework: before it, the list and the editor shared a
	// window, so a deleted playlist could not still be open somewhere. Now the
	// document window would stay mounted on a dead id, with File > Save PATCHing
	// a 404 and Control > Lock Clock sending a doomed room command.
	it("closes the document window of a playlist deleted from the list", async () => {
		editorCtx.openIds = ["p1"];
		api.deletePlaylist.mockResolvedValue(undefined);
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete \"Lesson One\"" }));

		await waitFor(() => expect(editorCtx.closePlaylistWindow).toHaveBeenCalledWith("p1"));
	});

	// Closing a window classicy has never heard of is not a no-op: its reducer
	// still refocuses this app's topmost window, which would pull focus off the
	// list the user is standing in.
	it("touches no document window when the deleted playlist is not open", async () => {
		editorCtx.openIds = ["p2"];
		api.deletePlaylist.mockResolvedValue(undefined);
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete \"Lesson One\"" }));

		await waitFor(() => expect(api.deletePlaylist).toHaveBeenCalledWith("p1"));
		expect(editorCtx.closePlaylistWindow).not.toHaveBeenCalled();
	});

	// A failed delete leaves the playlist there, so its window must stay too.
	it("leaves the document window alone when the delete fails", async () => {
		editorCtx.openIds = ["p1"];
		api.deletePlaylist.mockRejectedValue(new Error("nope"));
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete \"Lesson One\"" }));

		await waitFor(() => expect(document.querySelector(".playlistListError")).not.toBeNull());
		expect(editorCtx.closePlaylistWindow).not.toHaveBeenCalled();
	});

	// This window never unmounts now, so a rename or save in a document window
	// reaches it only through the refresh token.
	it("refetches when the refresh token changes", async () => {
		const { rerender } = render(<PlaylistList meId="u1" onOpen={() => {}} refreshToken={0} />);
		expect(await screen.findByText("Lesson One")).not.toBeNull();
		expect(api.listMine).toHaveBeenCalledTimes(1);

		api.listMine.mockResolvedValue([{ ...rows[0], title: "Renamed Lesson" }]);
		rerender(<PlaylistList meId="u1" onOpen={() => {}} refreshToken={1} />);

		expect(await screen.findByText("Renamed Lesson")).not.toBeNull();
		expect(screen.queryByText("Lesson One")).toBeNull();
	});

	it("shows Copy Link only for published playlists", async () => {
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		expect(screen.queryByRole("button", { name: "Copy Link" })).toBeNull();
		fireEvent.click(screen.getByText("Lesson Two"));
		expect(screen.getByRole("button", { name: "Copy Link" })).not.toBeNull();
	});

	// The list is a Platinum table (the Drive Setup control panel's list view),
	// not a bare row of buttons: name, status and last-modified are columns.
	it("renders the playlists as a table with name, status and modified columns", async () => {
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		await screen.findByText("Lesson One");
		// Matched loosely: the sorted column's header also carries a sort-arrow
		// image whose alt text joins its accessible name.
		for (const header of [/^Name/, /^Status/, /^Date Modified/]) {
			expect(screen.getByRole("columnheader", { name: header })).not.toBeNull();
		}
		expect(
			screen.getByRole("columnheader", { name: /^Date Modified/ }).getAttribute("aria-sort"),
		).toBe("descending");
		expect(screen.getAllByRole("row").length).toBeGreaterThan(rows.length);
	});

	it("shows the status readably and the modified date as a real local timestamp", async () => {
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		expect(await screen.findByText("Draft")).not.toBeNull();
		expect(screen.getByText("Published")).not.toBeNull();
		// Whatever the runner's zone, a midday-UTC instant stays on its own day.
		expect(screen.getByText(/2026/)).not.toBeNull();
		expect(screen.queryByText("2026-07-16T12:00:00Z")).toBeNull();
		// A playlist that has never been saved has no date to show.
		expect(screen.getByText("—")).not.toBeNull();
	});

	// The headline gesture of this window: double-click opens, exactly as the
	// Open button does, so the two can never drift apart.
	it("opens a playlist on double-click", async () => {
		const record = { ...rows[0], definition: { version: 1, mode: "restrict", entries: [] } };
		api.getPlaylist.mockResolvedValue(record);
		const onOpen = vi.fn();
		render(<PlaylistList meId="u1" onOpen={onOpen} />);
		fireEvent.doubleClick(await screen.findByText("Lesson One"));
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith(record));
		expect(api.getPlaylist).toHaveBeenCalledWith("p1");
	});

	it("reports a failed open from a double-click instead of failing silently", async () => {
		api.getPlaylist.mockRejectedValue(new Error("nope"));
		const onOpen = vi.fn();
		render(<PlaylistList meId="u1" onOpen={onOpen} />);
		fireEvent.doubleClick(await screen.findByText("Lesson One"));
		await waitFor(() =>
			expect(document.querySelector(".playlistListError")).not.toBeNull(),
		);
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("tells a teacher with no playlists that the list is empty", async () => {
		api.listMine.mockResolvedValue([]);
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		expect(await screen.findByText("No playlists yet.")).not.toBeNull();
		// The table chrome stays put so the window does not collapse to nothing.
		expect(screen.getByRole("columnheader", { name: "Name" })).not.toBeNull();
	});

	it("calls auth refresh when listMine rejects with AuthRequiredError", async () => {
		const { AuthRequiredError } = await vi.importActual<typeof import("../../Providers/Auth/authApi")>("../../Providers/Auth/authApi");
		api.listMine.mockRejectedValue(new AuthRequiredError("auth"));
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		await waitFor(() => expect(mockAuth.refresh).toHaveBeenCalledTimes(1));
		expect(document.querySelector(".playlistListError")).toBeNull();
	});
});
