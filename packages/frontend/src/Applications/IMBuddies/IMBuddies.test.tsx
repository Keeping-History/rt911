import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../Providers/Auth/authApi";
import type { ChatBuddy, ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

// --- Mutable state the mocked useIMBuddies() reads from, set per-test by
// renderApp(). Hoisted so the vi.mock() factories (which run before the rest
// of this module) can close over them — same pattern as
// ChatWindow.test.tsx/BuddyListWindow.test.tsx/InfoWindow.test.tsx.
const imState = vi.hoisted(() => ({
	connected: false,
	enabled: true,
	reason: "ok" as ChatStateReason,
	buddies: [] as ChatBuddy[],
	openChats: [] as number[],
	openInfo: [] as number[],
	typingProfile: null as number | null,
	signOn: vi.fn(),
	signOff: vi.fn(),
	openChat: vi.fn(),
	closeChat: vi.fn(),
	openInfoFor: vi.fn(),
	closeInfoFor: vi.fn(),
	send: vi.fn(),
	markRead: vi.fn(),
}));

// IMBuddies.tsx (and every window it composes) reaches useIMBuddies()/
// IMBuddiesProvider through this one relative path, so mocking it once here
// covers the whole tree mounted by renderApp() below -- same module-path
// trick InfoWindow.test.tsx/ChatWindow.test.tsx rely on.
vi.mock("./IMBuddiesProvider", () => ({
	IMBuddiesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	useIMBuddies: () => ({
		connected: imState.connected,
		enabled: imState.enabled,
		reason: imState.reason,
		buddies: imState.buddies,
		conversationFor: () => ({ messages: [], unread: 0 }),
		typingProfile: imState.typingProfile,
		openChats: imState.openChats,
		openInfo: imState.openInfo,
		signOn: imState.signOn,
		signOff: imState.signOff,
		openChat: imState.openChat,
		closeChat: imState.closeChat,
		openInfoFor: imState.openInfoFor,
		closeInfoFor: imState.closeInfoFor,
		send: imState.send,
		markRead: imState.markRead,
	}),
}));

// SignOnWindow's one real dependency outside IMBuddiesProvider.
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => ({ user: { username: "me" } as AuthUser }),
}));

// Partial classicy mock, same shape as ChatWindow.test.tsx/InfoWindow.test.tsx
// (importOriginal spread, override only what needs a real desktop/provider
// tree this test doesn't mount): ClassicyWindow needs a real
// ClassicyAppManagerProvider to render, and ClassicyApp drives its own
// open/registration lifecycle off that same store -- both are stubbed to
// plain passthroughs. ClassicyWindow's stub also surfaces `title` as text,
// standing in for the real title bar, since two of the four tests below
// assert on a window's title rather than its body content. Everything else
// (ClassicyMenuBarExtension, ClassicyInput, ClassicyButton, ...) is real.
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClassicyApp: (props: { name: string; children?: React.ReactNode }) => (
		<div>
			<div>{props.name}</div>
			{props.children}
		</div>
	),
	ClassicyWindow: (props: { title?: string; children?: React.ReactNode }) => (
		<div>
			<div>{props.title}</div>
			{props.children}
		</div>
	),
}));

import { IMBuddies } from "./IMBuddies";

// A non-empty default roster: several tests below don't override `buddies`
// at all, and a default of [] would let a mutant that iterates `buddies`
// instead of `openChats` (rendering a chat window per known buddy rather
// than per open conversation) slip through those tests undetected, since
// "no buddies" and "no open chats" would look identical either way. Test 4
// in particular exists to prove buddies existing is not enough on its own.
const DEFAULT_BUDDIES: ChatBuddy[] = [
	{ profile: 1, screen_name: "a", display_name: "", avatar: "", online: true },
	{ profile: 2, screen_name: "b", display_name: "", avatar: "", online: true },
];

function renderApp(
	overrides: {
		connected?: boolean;
		buddies?: ChatBuddy[];
		openChats?: number[];
		openInfo?: number[];
	} = {},
) {
	imState.connected = overrides.connected ?? false;
	imState.buddies = overrides.buddies ?? DEFAULT_BUDDIES;
	imState.openChats = overrides.openChats ?? [];
	imState.openInfo = overrides.openInfo ?? [];
	imState.enabled = true;
	imState.reason = "ok";
	imState.typingProfile = null;
	imState.signOn = vi.fn();
	imState.signOff = vi.fn();
	imState.openChat = vi.fn();
	imState.closeChat = vi.fn();
	imState.openInfoFor = vi.fn();
	imState.closeInfoFor = vi.fn();
	imState.send = vi.fn();
	imState.markRead = vi.fn();
	render(<IMBuddies />);
}

describe("IMBuddies", () => {
	it("starts on the sign-on window", () => {
		renderApp({ connected: false });
		expect(screen.getByText("Instant Messenger")).toBeTruthy();
	});

	it("shows the buddy list once connected", () => {
		renderApp({ connected: true });
		expect(screen.getByText("Buddy List")).toBeTruthy();
	});

	it("renders one chat window per open conversation", () => {
		renderApp({
			connected: true,
			openChats: [1, 2],
			buddies: [
				{ profile: 1, screen_name: "a", display_name: "", avatar: "", online: true },
				{ profile: 2, screen_name: "b", display_name: "", avatar: "", online: true },
			],
		});
		expect(screen.getAllByRole("textbox")).toHaveLength(2);
	});

	it("does not render a chat window for a closed conversation", () => {
		renderApp({ connected: true, openChats: [] });
		expect(screen.queryAllByRole("textbox")).toHaveLength(0);
	});
});
