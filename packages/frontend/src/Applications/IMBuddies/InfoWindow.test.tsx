import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBuddy } from "../../Providers/MediaStream/MediaStreamContext";
import { InfoWindow } from "./InfoWindow";

afterEach(cleanup);

// --- Mutable state the mocked useIMBuddies() reads from, set per-test by
// renderInfo(). Hoisted so the vi.mock() factory (which runs before the rest
// of this module) can close over it -- same pattern as ChatWindow.test.tsx.
const imState = vi.hoisted(() => ({
	buddies: [] as ChatBuddy[],
}));

vi.mock("./IMBuddiesProvider", () => ({
	useIMBuddies: () => ({
		buddies: imState.buddies,
		closeInfoFor: vi.fn(),
	}),
}));

// Partial classicy mock: ClassicyWindow requires a real
// ClassicyAppManagerProvider tree to render its children (same as
// ChatWindow.test.tsx/BuddyListWindow.test.tsx), so it alone is stubbed to a
// plain passthrough div. Everything else is left real.
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClassicyWindow: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
}));

function renderInfo(profile: number, buddy: ChatBuddy) {
	imState.buddies = [buddy];
	render(<InfoWindow profile={profile} />);
}

describe("InfoWindow", () => {
	it("shows the student-facing profile", () => {
		renderInfo(1, {
			profile: 1,
			screen_name: "skaterboi1988",
			display_name: "Danny",
			avatar: "",
			online: true,
			profile_text: "13. eighth grade.",
		});
		expect(screen.getByText(/13\. eighth grade\./)).toBeTruthy();
	});

	it("says nothing rather than something wrong when there is no profile", () => {
		// profile_text is deliberately allowed to be empty. Falling back to the
		// persona would print a second-person instruction to a model at a student.
		renderInfo(1, { profile: 1, screen_name: "a", display_name: "", avatar: "", online: true });
		expect(screen.getByText("No profile.")).toBeTruthy();
	});

	it("shows whether they are online", () => {
		renderInfo(1, { profile: 1, screen_name: "a", display_name: "", avatar: "", online: false });
		expect(screen.getByText(/Offline/)).toBeTruthy();
	});
});
