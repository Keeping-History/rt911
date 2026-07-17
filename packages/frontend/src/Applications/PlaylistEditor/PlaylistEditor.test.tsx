import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatchMock = vi.fn();
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
		<div data-testid={`window-${title}`}>{children}</div>
	),
	useAppManagerDispatch: () => dispatchMock,
}));

const mockAuth = vi.hoisted(() => ({
	status: "anonymous" as string,
	user: null as { id: string } | null,
}));
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => mockAuth,
}));

import { PlaylistEditor } from "./PlaylistEditor";

beforeEach(() => {
	mockAuth.status = "anonymous";
	mockAuth.user = null;
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
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
		expect(screen.getByText("My Playlists")).not.toBeNull();
	});
});
