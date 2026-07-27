import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type React from "react";
import { createContext, useContext, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../Providers/Auth/authApi";
import type { ChatBuddy, ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

// The menu-bar extension shows the app ICON alone (#323) — its accessible name
// comes from the extension's title and the icon's alt text, not from a visible
// word, so tests address it by that rather than by "People"/"Window".
const MENU_NAME = "Instant Messenger";

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
	infoProfile: null as number | null,
	typingProfile: null as number | null,
	focusedAppId: "IMBuddies.app",
	signOn: vi.fn(),
	signOff: vi.fn(),
	openChat: vi.fn(),
	closeChat: vi.fn(),
	openInfoFor: vi.fn(),
	closeInfo: vi.fn(),
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
			infoProfile: imState.infoProfile,
			signOn: imState.signOn,
			signOff: imState.signOff,
			openChat: imState.openChat,
			closeChat: imState.closeChat,
			openInfoFor: imState.openInfoFor,
			closeInfo: imState.closeInfo,
			send: imState.send,
			markRead: imState.markRead,
			selectedBuddy,
			selectBuddy,
		};
	},
}));

// SignOnWindow's one real dependency outside IMBuddiesProvider -- and now
// IMBuddiesContent's too, which shows a sign-in-required alert when there is
// no session. Mutable so a test can render the signed-out case.
const authStore = vi.hoisted(() => ({ user: null as { username?: string } | null }));
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => ({ user: authStore.user as AuthUser | null }),
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
	// Records the window-level props this app's tests assert on: which windows
	// carry a File menu, which are closable, and which are utility windows.
	// Menu items render as <span>, deliberately not <button>, so they cannot
	// collide with the sign-in alert's real "Quit" button in a role query.
	ClassicyWindow: (props: {
		title?: string;
		children?: React.ReactNode;
		closable?: boolean;
		windowType?: string;
		appMenu?: { id?: string; title?: string; menuChildren?: { id?: string; title?: string }[] }[];
	}) => (
		<div
			data-testid="window"
			data-window-title={props.title}
			data-closable={String(props.closable)}
			data-window-type={props.windowType ?? ""}
			data-menus={(props.appMenu ?? []).map((m) => m.id).join(",")}
		>
			<div>{props.title}</div>
			{(props.appMenu ?? []).map((menu) => (
				<div key={menu.id} data-testid={`menu-${menu.id}`}>
					{(menu.menuChildren ?? []).map((item) => (
						<span key={item.id}>{item.title}</span>
					))}
				</div>
			))}
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
		infoProfile?: number | null;
		focusedAppId?: string;
		/** Directus session; signed in unless a test says otherwise. */
		user?: { username?: string } | null;
	} = {},
) {
	imState.connected = overrides.connected ?? false;
	imState.buddies = overrides.buddies ?? DEFAULT_BUDDIES;
	imState.openChats = overrides.openChats ?? [];
	imState.infoProfile = overrides.infoProfile ?? null;
	authStore.user = overrides.user === undefined ? { username: "me" } : overrides.user;
	imState.enabled = true;
	imState.reason = "ok";
	imState.typingProfile = null;
	imState.focusedAppId = overrides.focusedAppId ?? APP_ID;
	imState.signOn = vi.fn();
	imState.signOff = vi.fn();
	imState.openChat = vi.fn();
	imState.closeChat = vi.fn();
	imState.openInfoFor = vi.fn();
	imState.closeInfo = vi.fn();
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
		expect(screen.getByRole("button", { name: MENU_NAME })).toBeTruthy();
	});

	it("hides the People menu when another app is frontmost", () => {
		renderApp({ connected: true, focusedAppId: "TV.app" });
		expect(screen.queryByRole("button", { name: MENU_NAME })).toBeNull();
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
		fireEvent.click(screen.getByRole("button", { name: MENU_NAME }));
		fireEvent.click(screen.getByRole("button", { name: "Get Info" }));
		expect(imState.openInfoFor).toHaveBeenCalledWith(2);
		expect(imState.openInfoFor).not.toHaveBeenCalledWith(1);
	});

	it("disables Get Info with nothing selected", () => {
		renderApp({ connected: true });
		fireEvent.click(screen.getByRole("button", { name: MENU_NAME }));
		const getInfo = screen.getByRole("button", { name: "Get Info" }) as HTMLButtonElement;
		expect(getInfo.disabled).toBe(true);
		fireEvent.click(getInfo);
		expect(imState.openInfoFor).not.toHaveBeenCalled();
	});

	it("renders exactly one Info window, for the profile it is retargeted to (#325)", () => {
		// The bug: openInfoFor appended to a list, so a second Get Info opened a
		// SECOND window at the same centred position, behind the first — and
		// pressing Info for another buddy looked like it did nothing at all.
		renderApp({
			connected: true,
			infoProfile: 2,
			buddies: [
				{ profile: 1, screen_name: "danny99", display_name: "Danny", avatar: "", online: true },
				{ profile: 2, screen_name: "carolm", display_name: "Carol", avatar: "", online: true },
			],
		});
		expect(screen.getAllByText(/^Info: /)).toHaveLength(1);
		expect(screen.getByText("Info: carolm")).toBeTruthy();
	});

	it("opens no Info window when nothing has been retargeted to", () => {
		renderApp({ connected: true, infoProfile: null });
		expect(screen.queryByText(/^Info: /)).toBeNull();
	});

	it("warns a signed-out student, offering Quit and Sign In", () => {
		// Signed out, nothing in this app can work: chat identity is the Directus
		// session cookie, so the streamer refuses every send regardless. Say so
		// rather than letting them press Sign On and land somewhere else.
		renderApp({ connected: false, user: null });
		expect(screen.getByText("You must be signed in to use Instant Messenger.")).toBeTruthy();
		// Quit is unique to the alert, so it locates the alert's own button row.
		// "Sign In" deliberately appears TWICE on screen while signed out — once
		// here and once on the Sign On window behind it — because both do the
		// same thing (open the Account app), so the query is scoped rather than
		// either label being changed to make the test easier.
		const quit = screen.getByRole("button", { name: "Quit" });
		const alertButtons = within(quit.parentElement as HTMLElement);
		expect(alertButtons.getByRole("button", { name: "Sign In" })).toBeTruthy();
	});

	it("does not warn a signed-in student", () => {
		renderApp({ connected: false, user: { username: "me" } });
		expect(screen.queryByText("You must be signed in to use Instant Messenger.")).toBeNull();
	});
});

describe("File menu", () => {
	// Helper: the windows currently rendered, by title, with whether each one
	// carries a File menu whose items include Quit.
	function windowsWithFileMenu() {
		return Array.from(document.querySelectorAll("[data-testid='window']")).map((w) => ({
			title: w.getAttribute("data-window-title") ?? "",
			hasFile: (w.getAttribute("data-menus") ?? "").split(",").includes("file"),
			hasQuit: within(w as HTMLElement).queryByText("Quit") !== null,
		}));
	}

	it("gives the Sign On window File -> Quit", () => {
		renderApp({ connected: false });
		const signOn = windowsWithFileMenu().find((w) => w.title === "Sign On");
		expect(signOn).toBeDefined();
		expect(signOn?.hasFile).toBe(true);
		expect(signOn?.hasQuit).toBe(true);
	});

	// Asserted as an invariant over whatever windows are on screen rather than
	// against hardcoded titles: every window this app opens carries File -> Quit
	// EXCEPT Get Info. Naming the windows would couple the test to the buddy
	// fixture's screen names, which is how the first version of this test broke.
	it("gives every window except Get Info a File -> Quit", () => {
		renderApp({ connected: true, openChats: [1], infoProfile: 2 });
		const windows = windowsWithFileMenu();
		expect(windows.length).toBeGreaterThan(1);

		const info = windows.filter((w) => w.title.startsWith("Info:"));
		const rest = windows.filter((w) => !w.title.startsWith("Info:"));

		expect(info, "expected a Get Info window").toHaveLength(1);
		expect(rest.length, "expected the Buddy List and a chat window").toBeGreaterThanOrEqual(2);

		for (const win of rest) {
			expect(win.hasFile, `${win.title} should carry a File menu`).toBe(true);
			expect(win.hasQuit, `${win.title} should offer Quit`).toBe(true);
		}
		// Get Info is a utility window. Classicy's focus reducer only assigns
		// Desktop.appMenu when the focused window supplies one, so leaving this
		// window menu-less keeps the previous window's File menu on screen
		// rather than blanking the menu bar.
		expect(info[0].hasFile).toBe(false);
		expect(info[0].hasQuit).toBe(false);
	});
});
