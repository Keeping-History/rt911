import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
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
	openChat: vi.fn(),
	openInfoFor: vi.fn(),
}));

vi.mock("./IMBuddiesProvider", () => ({
	useIMBuddies: () => ({
		buddies: imState.buddies,
		enabled: imState.enabled,
		reason: imState.reason,
		openChat: imState.openChat,
		openInfoFor: imState.openInfoFor,
	}),
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
	overrides: { buddies?: ChatBuddy[]; enabled?: boolean; reason?: ChatStateReason } = {},
) {
	imState.buddies = overrides.buddies ?? [];
	imState.enabled = overrides.enabled ?? true;
	imState.reason = overrides.reason ?? "ok";
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

	it("renders the status line for the current reason", () => {
		renderBuddyList({ buddies: [], reason: "outside_window" });
		expect(screen.getByText(/Nobody is online until/)).toBeTruthy();
	});
});
