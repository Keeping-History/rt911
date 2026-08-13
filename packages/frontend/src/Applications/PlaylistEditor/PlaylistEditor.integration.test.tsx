import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const dispatchMock = vi.fn();
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({
		children,
		title,
		id: _id, // eslint-disable-line @typescript-eslint/no-unused-vars
		onCloseFunc: _onCloseFunc, // eslint-disable-line @typescript-eslint/no-unused-vars
	}: {
		children?: React.ReactNode;
		title?: string;
		id?: string;
		onCloseFunc?: () => void;
	}) => {
		return <div data-testid={`window-${title}`}>{children}</div>;
	},
	useAppManagerDispatch: () => dispatchMock,
}));

const apiMocks = vi.hoisted(() => ({
	listMine: vi.fn(),
	getPlaylist: vi.fn(),
}));
vi.mock("../../Providers/Auth/playlistApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../Providers/Auth/playlistApi")>()),
	listMine: apiMocks.listMine,
	getPlaylist: apiMocks.getPlaylist,
}));

const mockAuth = vi.hoisted(() => ({
	status: "signedIn" as string,
	user: { id: "u1" } as { id: string } | null,
}));
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => mockAuth,
}));

import { PlaylistEditor } from "./PlaylistEditor";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PlaylistEditor integration with real PlaylistList", () => {
	it("renders the real PlaylistList when signed in and asserts listMine is called with userId", async () => {
		const testRecord = {
			id: "p1",
			title: "Lesson One",
			status: "draft" as const,
			date_updated: null,
			user_created: "u1",
		};
		apiMocks.listMine.mockResolvedValue([testRecord]);

		render(<PlaylistEditor />);

		// The real PlaylistList component should render and load data
		expect(await screen.findByText("Lesson One")).not.toBeNull();

		// Verify listMine was called with the signed-in user's ID
		expect(apiMocks.listMine).toHaveBeenCalledWith("u1");
	});

	const summary = (id: string, title: string) => ({
		id, title, status: "draft" as const, date_updated: null, user_created: "u1",
	});
	const record = (id: string, title: string) => ({
		...summary(id, title),
		definition: { version: 1 as const, mode: "annotate" as const, entries: [] },
	});

	const openFromList = async (title: string) => {
		fireEvent.click(await screen.findByText(title));
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
	};

	it("opens each playlist into its own window, titled by playlist", async () => {
		apiMocks.listMine.mockResolvedValue([summary("p1", "Lesson One"), summary("p2", "Lesson Two")]);
		apiMocks.getPlaylist.mockImplementation(async (id: string) =>
			id === "p1" ? record("p1", "Lesson One") : record("p2", "Lesson Two"),
		);
		render(<PlaylistEditor />);

		await openFromList("Lesson One");
		await waitFor(() => expect(screen.getByTestId("window-Lesson One")).not.toBeNull());

		await openFromList("Lesson Two");
		await waitFor(() => expect(screen.getByTestId("window-Lesson Two")).not.toBeNull());

		// Both documents AND the list survive — the whole point of the rework.
		expect(screen.getByTestId("window-Lesson One")).not.toBeNull();
		expect(screen.getByTestId("window-Playlists")).not.toBeNull();
	});

	// Reopening from the list must not re-seed from the record: that would throw
	// away unsaved edits the moment a user clicked a playlist they already had open.
	it("reopening an already-open playlist does not add a second window", async () => {
		apiMocks.listMine.mockResolvedValue([summary("p1", "Lesson One")]);
		apiMocks.getPlaylist.mockResolvedValue(record("p1", "Lesson One"));
		render(<PlaylistEditor />);

		await openFromList("Lesson One");
		await waitFor(() => expect(screen.getByTestId("window-Lesson One")).not.toBeNull());
		await openFromList("Lesson One");

		expect(screen.getAllByTestId("window-Lesson One")).toHaveLength(1);
	});
});
