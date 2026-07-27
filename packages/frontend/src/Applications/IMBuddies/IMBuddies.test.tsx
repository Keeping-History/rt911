import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { createContext, useContext, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../Providers/Auth/authApi";
import type { ChatBuddy, ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

// Same app id IMBuddies.tsx subscribes/dispatches under — not exported from
// there, so it is repeated here (same convention every window file uses).
const APP_ID = "IMBuddies.app";

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
	focusedAppId: "IMBuddies.app",
	signOn: vi.fn(),
	signOff: vi.fn(),
	openChat: vi.fn(),
	closeChat: vi.fn(),
	openInfoFor: vi.fn(),
	closeInfoFor: vi.fn(),
	send: vi.fn(),
	markRead: vi.fn(),
}));

// selectedBuddy/selectBuddy were lifted from BuddyListWindow's own useState
// into IMBuddiesProvider (Task 10 fix) specifically so the People menu could
// see the same selection. That means this test needs the mocked
// useIMBuddies() to share ONE piece of REAL, reactive state between two
// sibling real components (BuddyListWindow and the People/Window menus) --
// a plain field on `imState` can't do that (mutating it doesn't trigger a
// re-render), so the mocked IMBuddiesProvider carries real useState in a
// small React context both consumers read through the mocked hook. Every
// other field on the provider value stays a static imState field, set by
// renderApp(), same as the other window test files.
const SelectionContext = createContext<{
	selectedBuddy: number | null;
	selectBuddy: (profile: number | null) => void;
}>({ selectedBuddy: null, selectBuddy: () => {} });

// IMBuddies.tsx (and every window it composes) reaches useIMBuddies()/
// IMBuddiesProvider through this one relative path, so mocking it once here
// covers the whole tree mounted by renderApp() below -- same module-path
// trick InfoWindow.test.tsx/ChatWindow.test.tsx rely on.
vi.mock("./IMBuddiesProvider", () => ({
	IMBuddiesProvider: ({ children }: { children: React.ReactNode }) => {
		const [selectedBuddy, selectBuddy] = useState<number | null>(null);
		return (
			<SelectionContext.Provider value={{ selectedBuddy, selectBuddy }}>
				{children}
			</SelectionContext.Provider>
		);
	},
	useIMBuddies: () => {
		const { selectedBuddy, selectBuddy } = useContext(SelectionContext);
		return {
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
			selectedBuddy,
			selectBuddy,
		};
	},
}));

// SignOnWindow's one real dependency outside IMBuddiesProvider.
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => ({ user: { username: "me" } as AuthUser }),
}));

// Minimal shape of the one ClassicyMenuItem field set this file's mock
// trigger/dropdown needs -- avoids importing the real (larger) type just for
// a test stub.
interface MockMenuItem {
	id: string;
	title?: string;
	disabled?: boolean;
	onClickFunc?: () => void;
}

// Partial classicy mock, same shape as ChatWindow.test.tsx/InfoWindow.test.tsx
// (importOriginal spread, override only what needs a real desktop/provider
// tree this test doesn't mount): ClassicyWindow needs a real
// ClassicyAppManagerProvider to render, and ClassicyApp drives its own
// open/registration lifecycle off that same store -- both are stubbed to
// plain passthroughs. ClassicyWindow's stub also surfaces `title` as text,
// standing in for the real title bar, since two of the four tests below
// assert on a window's title rather than its body content. useAppManager is
// stubbed to read `imState.focusedAppId` -- IMBuddiesContent's frontmost
// gate reads it the same way PlaylistProvider.tsx does, and nothing else in
// this tree calls useAppManager directly, so this is a safe full override.
//
// ClassicyMenuBarExtension is ALSO stubbed, for a reason specific to jsdom
// rather than to this app: the real component defers a clicked item's
// onClickFunc to a requestAnimationFrame queued from the CSS flash
// animation's `animationend` event (see classicy's ClassicyMenu source) --
// real browser behavior, but jsdom's React build never dispatches
// `animationend` (confirmed empirically: a bare `onAnimationEnd` handler on
// a real DOM node never fires here, dispatchEvent or fireEvent alike), so a
// clicked item's action can never complete through the real component in
// this test environment. The stub below preserves the same observable
// contract (a trigger button labelled by `children`, a dropdown of
// `menuItems` keyed on `disabled` + `onClickFunc`) using plain native
// buttons, so `disabled` is enforced by the browser/jsdom itself rather than
// by re-implementing the real component's gating logic.
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
	ClassicyMenuBarExtension: (props: {
		title?: string;
		menuItems?: MockMenuItem[];
		children?: React.ReactNode;
	}) => {
		const [open, setOpen] = useState(false);
		return (
			<div>
				<button type="button" aria-label={props.title} onClick={() => setOpen((o) => !o)}>
					{props.children}
				</button>
				{open && (
					<ul>
						{(props.menuItems ?? []).map((item) => (
							<li key={item.id}>
								<button type="button" disabled={item.disabled} onClick={item.onClickFunc}>
									{item.title}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		);
	},
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: { Manager: { Applications: { focusedAppId: imState.focusedAppId } } },
		}),
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
		focusedAppId?: string;
	} = {},
) {
	imState.connected = overrides.connected ?? false;
	imState.buddies = overrides.buddies ?? DEFAULT_BUDDIES;
	imState.openChats = overrides.openChats ?? [];
	imState.openInfo = overrides.openInfo ?? [];
	imState.enabled = true;
	imState.reason = "ok";
	imState.typingProfile = null;
	imState.focusedAppId = overrides.focusedAppId ?? APP_ID;
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

describe("People/Window menus are frontmost-only", () => {
	// An app's own menus belong to the frontmost app in a Mac OS 8 desktop --
	// unlike ClassicyMenuBarExtension's own portal (which has no such gate
	// built in), IMBuddiesContent only mounts <IMBuddiesMenus /> while
	// focusedAppId names this app. Both directions are asserted: checking
	// only "present when frontmost" would also pass against a component that
	// renders unconditionally.
	it("shows the People menu while this app is frontmost", () => {
		renderApp({ connected: true, focusedAppId: APP_ID });
		expect(screen.getByText("People")).toBeTruthy();
	});

	it("hides the People menu when another app is frontmost", () => {
		renderApp({ connected: true, focusedAppId: "TV.app" });
		expect(screen.queryByText("People")).toBeNull();
	});
});

describe("People menu acts on the Buddy List selection", () => {
	it("Get Info acts on the selected buddy, not just the first one in the roster", () => {
		// Two buddies, and Carol (profile 2) -- not the first buddy in the
		// array -- is the one actually selected. A menu that ignored the
		// selection and reached for buddies[0] would pass a single-buddy
		// fixture just as easily; this is the same blind spot Task 9's
		// InfoWindow test guards against, one level up the tree.
		renderApp({
			connected: true,
			buddies: [
				{ profile: 1, screen_name: "danny99", display_name: "Danny", avatar: "", online: true },
				{ profile: 2, screen_name: "carolm", display_name: "Carol", avatar: "", online: true },
			],
		});
		fireEvent.click(screen.getByText("carolm"));
		fireEvent.click(screen.getByRole("button", { name: "People" }));
		fireEvent.click(screen.getByRole("button", { name: "Get Info" }));
		expect(imState.openInfoFor).toHaveBeenCalledWith(2);
		expect(imState.openInfoFor).not.toHaveBeenCalledWith(1);
	});

	it("disables Get Info with nothing selected", () => {
		renderApp({ connected: true });
		fireEvent.click(screen.getByRole("button", { name: "People" }));
		const getInfo = screen.getByRole("button", { name: "Get Info" }) as HTMLButtonElement;
		expect(getInfo.disabled).toBe(true);
		fireEvent.click(getInfo);
		expect(imState.openInfoFor).not.toHaveBeenCalled();
	});
});
