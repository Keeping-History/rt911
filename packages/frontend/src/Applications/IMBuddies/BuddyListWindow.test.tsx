import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBuddy, ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import { BuddyListWindow, statusLineFor } from "./BuddyListWindow";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

describe("statusLineFor", () => {
	it("explains each refusal in one sentence", () => {
		expect(statusLineFor("outside_window", "8:00 AM")).toBe("Nobody is online until 8:00 AM.");
		expect(statusLineFor("paused", "8:00 AM")).toBe("Clock paused.");
		expect(statusLineFor("blocked", "8:00 AM")).toBe("You can't send messages right now.");
	});

	it("says when it signed on rather than nothing", () => {
		expect(statusLineFor("ok", "8:00 AM")).toMatch(/Signed on/);
	});
});

// --- Mutable state the mocked useIMBuddies() reads from, set per-test by
// renderBuddyList(). Hoisted so the vi.mock() factory (which runs before the
// rest of this module) can close over it.
const imState = vi.hoisted(() => ({
	buddies: [] as ChatBuddy[],
	enabled: true,
	reason: "ok" as ChatStateReason,
	// Unread count per profile, as conversationFor() would report it.
	unread: {} as Record<number, number>,
	openChat: vi.fn(),
	openInfoFor: vi.fn(),
}));

vi.mock("./IMBuddiesProvider", () => ({
	useIMBuddies: () => {
		// Task 10 lifted buddy selection out of this window's own useState and
		// into IMBuddiesProvider. Mocking it back in with a REAL useState here
		// (rather than a plain object field) is what keeps this component's
		// selection reactive across renders without mounting the real
		// provider — clicking a row calls the returned setter, which is a
		// genuine React state setter bound to this component's own fiber.
		const [selectedBuddy, selectBuddy] = useState<number | null>(null);
		return {
			buddies: imState.buddies,
			enabled: imState.enabled,
			reason: imState.reason,
			conversationFor: (profile: number) => ({
				messages: [],
				unread: imState.unread[profile] ?? 0,
			}),
			openChat: imState.openChat,
			openInfoFor: imState.openInfoFor,
			selectedBuddy,
			selectBuddy,
		};
	},
}));

// Partial classicy mock, same shape as SignOnWindow.checkboxes.test.tsx:
// ClassicyWindow requires a real ClassicyAppManagerProvider tree to render
// its children, so it's stubbed to a plain passthrough div. ClassicyButton is
// stubbed to a real <button> — a native disabled button already refuses
// clicks with no internal-state trap to fall into (unlike ClassicyCheckbox),
// so a stub is safe here; nothing else from classicy is touched.
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClassicyWindow: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	ClassicyButton: (props: {
		children?: React.ReactNode;
		disabled?: boolean;
		onClickFunc?: () => void;
	}) => (
		<button type="button" disabled={props.disabled} onClick={props.onClickFunc}>
			{props.children}
		</button>
	),
}));

function renderBuddyList(
	overrides: {
		buddies?: ChatBuddy[];
		enabled?: boolean;
		reason?: ChatStateReason;
		unread?: Record<number, number>;
	} = {},
) {
	imState.buddies = overrides.buddies ?? [];
	imState.enabled = overrides.enabled ?? true;
	imState.reason = overrides.reason ?? "ok";
	imState.unread = overrides.unread ?? {};
	imState.openChat = vi.fn();
	imState.openInfoFor = vi.fn();
	render(<BuddyListWindow />);
	return { openChat: imState.openChat, openInfoFor: imState.openInfoFor };
}

describe("BuddyListWindow", () => {
	it("groups online buddies with a count", () => {
		renderBuddyList({
			buddies: [
				{ profile: 1, screen_name: "a", display_name: "", avatar: "", online: true },
				{ profile: 2, screen_name: "b", display_name: "", avatar: "", online: false },
			],
		});
		expect(screen.getByText("Buddies (1/2)")).toBeTruthy();
	});

	it("opens a chat on double-click", () => {
		const { openChat } = renderBuddyList({
			buddies: [{ profile: 1, screen_name: "a", display_name: "", avatar: "", online: true }],
		});
		fireEvent.doubleClick(screen.getByText("a"));
		expect(openChat).toHaveBeenCalledWith(1);
	});

	it("does not open a chat for an offline buddy", () => {
		const { openChat } = renderBuddyList({
			buddies: [{ profile: 1, screen_name: "a", display_name: "", avatar: "", online: false }],
		});
		fireEvent.doubleClick(screen.getByText("a"));
		expect(openChat).not.toHaveBeenCalled();
	});

	it("disables IM and Info with nothing selected", () => {
		renderBuddyList({ buddies: [] });
		expect((screen.getByRole("button", { name: "IM" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("disables IM and Info when the selection is offline", () => {
		renderBuddyList({
			buddies: [{ profile: 1, screen_name: "a", display_name: "", avatar: "", online: false }],
		});
		fireEvent.click(screen.getByText("a"));
		expect((screen.getByRole("button", { name: "IM" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "Info" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("enables IM and Info once an online buddy is selected, and IM/Info act on it", () => {
		const { openChat, openInfoFor } = renderBuddyList({
			buddies: [{ profile: 7, screen_name: "a", display_name: "", avatar: "", online: true }],
		});
		fireEvent.click(screen.getByText("a"));
		const im = screen.getByRole("button", { name: "IM" }) as HTMLButtonElement;
		const info = screen.getByRole("button", { name: "Info" }) as HTMLButtonElement;
		expect(im.disabled).toBe(false);
		expect(info.disabled).toBe(false);
		fireEvent.click(im);
		expect(openChat).toHaveBeenCalledWith(7);
		fireEvent.click(info);
		expect(openInfoFor).toHaveBeenCalledWith(7);
	});

	it("shows an unread count on the buddy's row", () => {
		// With no receive sound asset shipped, this badge is the only signal a
		// message arrived for a buddy whose window is closed — including a
		// server-initiated scheduled beat.
		renderBuddyList({
			buddies: [
				{ profile: 1, screen_name: "danny99", display_name: "", avatar: "", online: true },
				{ profile: 2, screen_name: "carolm", display_name: "", avatar: "", online: true },
			],
			unread: { 2: 3 },
		});
		const carolRow = screen.getByText("carolm").closest("div");
		expect(carolRow?.textContent).toContain("3");
		// ...and only on that buddy's row, not everyone's.
		expect(screen.getByText("danny99").closest("div")?.textContent).toBe("danny99");
	});

	it("shows no badge for a conversation with nothing unread", () => {
		renderBuddyList({
			buddies: [{ profile: 1, screen_name: "danny99", display_name: "", avatar: "", online: true }],
			unread: { 1: 0 },
		});
		expect(screen.getByText("danny99").closest("div")?.textContent).toBe("danny99");
	});

	it("shows an unread count for an OFFLINE buddy too", () => {
		// The offline group is a separate map() over the same row component; a
		// badge wired into only the online list would look complete and still
		// hide the scheduled beats that arrive after a buddy goes offline.
		renderBuddyList({
			buddies: [{ profile: 5, screen_name: "gone", display_name: "", avatar: "", online: false }],
			unread: { 5: 2 },
		});
		expect(screen.getByText("gone").closest("div")?.textContent).toContain("2");
	});

	it("renders the status line for the current reason", () => {
		renderBuddyList({ buddies: [], reason: "outside_window" });
		expect(screen.getByText(/Nobody is online until/)).toBeTruthy();
	});
});
