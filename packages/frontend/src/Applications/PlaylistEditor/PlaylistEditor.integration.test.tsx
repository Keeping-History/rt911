import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
}));
vi.mock("../../Providers/Auth/playlistApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../Providers/Auth/playlistApi")>()),
	listMine: apiMocks.listMine,
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
});
