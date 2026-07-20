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

import { PlaylistList } from "./PlaylistList";

const rows = [
	{ id: "p1", title: "Lesson One", status: "draft", date_updated: "2026-07-16T00:00:00Z", user_created: "u1" },
	{ id: "p2", title: "Lesson Two", status: "published", date_updated: null, user_created: "u1" },
];

beforeEach(() => {
	api.listMine.mockResolvedValue(rows);
	mockAuth.refresh.mockResolvedValue(undefined);
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

	it("shows Copy Link only for published playlists", async () => {
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		expect(screen.queryByRole("button", { name: "Copy Link" })).toBeNull();
		fireEvent.click(screen.getByText("Lesson Two"));
		expect(screen.getByRole("button", { name: "Copy Link" })).not.toBeNull();
	});

	it("calls auth refresh when listMine rejects with AuthRequiredError", async () => {
		const { AuthRequiredError } = await vi.importActual<typeof import("../../Providers/Auth/authApi")>("../../Providers/Auth/authApi");
		api.listMine.mockRejectedValue(new AuthRequiredError("auth"));
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		await waitFor(() => expect(mockAuth.refresh).toHaveBeenCalledTimes(1));
		expect(document.querySelector(".playlistListError")).toBeNull();
	});
});
