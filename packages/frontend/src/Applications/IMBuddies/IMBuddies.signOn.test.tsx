// The one IM Buddies test that mounts the REAL IMBuddiesProvider under the app.
//
// Every other IMBuddies.tsx test mocks ./IMBuddiesProvider wholesale and
// *injects* `connected`, so none of them exercises how the provider actually
// derives that flag — which is precisely how a provider that forwarded
// MediaStreamContext's raw socket flag verbatim (so the Sign On window never
// rendered on a live socket, and subscribeChat could never fire) passed a full
// suite. This file stubs only MediaStreamContext and mounts everything above
// it for real.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../Providers/Auth/authApi";
import type {
	ChatBuddy,
	ChatStateReason,
	MediaStreamContextValue,
} from "../../Providers/MediaStream/MediaStreamContext";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => ({ user: { username: "skaterboi1988" } as AuthUser }),
}));

// Minimal shape of the one ClassicyMenuItem field set this file's menu stub
// needs — same trimmed interface IMBuddies.test.tsx declares.
interface MockMenuItem {
	id: string;
	title?: string;
	disabled?: boolean;
	onClickFunc?: () => void;
}

// Partial classicy mock (importOriginal spread, override as little as
// possible): only the pieces that need a real ClassicyAppManagerProvider /
// desktop tree this test doesn't mount. ClassicyButton, ClassicyInput,
// ClassicyPopUpMenu and ClassicyCheckbox stay REAL — the whole point of this
// file is that a stub more inert than the real thing is what hid the defect.
// ClassicyMenuBarExtension is stubbed to plain buttons for the same jsdom
// reason IMBuddies.test.tsx documents (the real component defers a clicked
// item's action to an `animationend` jsdom never dispatches).
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClassicyApp: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	ClassicyWindow: (props: { title?: string; children?: React.ReactNode }) => (
		<div>
			<div data-testid="window-title">{props.title}</div>
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
			System: { Manager: { Applications: { focusedAppId: "IMBuddies.app" } } },
		}),
	useAppManagerDispatch: () => () => {},
	useSoundDispatch: () => () => {},
	useClassicyDateTime: () => ({
		localDate: new Date("2001-09-11T13:00:00.000Z"),
		dateTime: "2001-09-11T13:00:00.000Z",
		tzOffset: 0,
	}),
}));

import { IMBuddies } from "./IMBuddies";

const BUDDIES: ChatBuddy[] = [
	{ profile: 1, screen_name: "danny99", display_name: "Danny", avatar: "", online: true },
];

/**
 * Mounts the whole app with a LIVE socket (`connected: true`) but nothing
 * signed on yet. `chatReason` defaults to "not_signed_in" deliberately: that
 * is the only value the client can hold before it subscribes, because the
 * streamer sends chat_state exclusively in reply to a `subscribe` (see
 * packages/backend/internal/handler/ws.go's "subscribe" case).
 */
function renderApp(overrides: { chatReason?: ChatStateReason; connected?: boolean } = {}) {
	const subscribeChat = vi.fn();
	const unsubscribeChat = vi.fn();

	const valueFor = (connected: boolean) =>
		({
			chatBuddies: BUDDIES,
			chatEnabled: true,
			chatReason: overrides.chatReason ?? "not_signed_in",
			chatMessages: [],
			chatTypingProfile: null,
			connected,
			subscribeChat,
			unsubscribeChat,
			sendChat: vi.fn(),
			requestChatHistory: vi.fn(),
			appendLocalChatMessage: vi.fn(),
		}) as unknown as MediaStreamContextValue;

	const tree = (connected: boolean) => (
		<MediaStreamContext.Provider value={valueFor(connected)}>
			<IMBuddies />
		</MediaStreamContext.Provider>
	);

	const utils = render(tree(overrides.connected ?? true));
	return {
		subscribeChat,
		unsubscribeChat,
		dropSocket: () => utils.rerender(tree(false)),
	};
}

function windowTitles(): string[] {
	return screen.queryAllByTestId("window-title").map((el) => el.textContent ?? "");
}

describe("IM Buddies sign-on, with the real provider", () => {
	it("shows the Sign On window on a live socket that has not signed on", () => {
		// `connected` on IMBuddiesValue means "Sign On pressed, chat channel
		// subscribed" (design.md), NOT "the WebSocket is up". Forwarding the
		// socket flag straight through hides this window for every student
		// whose socket is healthy — i.e. all of them.
		renderApp();
		expect(windowTitles()).toContain("Sign On");
		expect(windowTitles()).not.toContain("Buddy List");
	});

	it("subscribes the chat channel when Sign On is pressed, and swaps in the Buddy List", () => {
		const { subscribeChat } = renderApp();
		fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
		expect(subscribeChat).toHaveBeenCalledWith("IMBuddies.app");
		expect(windowTitles()).toContain("Buddy List");
		expect(windowTitles()).not.toContain("Sign On");
	});

	it("returns to the Sign On window on Sign Off, and unsubscribes", () => {
		const { unsubscribeChat } = renderApp();
		fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
		fireEvent.click(screen.getByRole("button", { name: "People" }));
		fireEvent.click(screen.getByRole("button", { name: "Sign Off" }));
		expect(unsubscribeChat).toHaveBeenCalledWith("IMBuddies.app");
		expect(windowTitles()).toContain("Sign On");
		expect(windowTitles()).not.toContain("Buddy List");
	});

	it("returns to the Sign On window when the socket drops underneath a signed-on student", () => {
		// The design's "socket drops -> the Sign On window returns" falls out of
		// deriving `connected` as signedOn AND socketConnected; it is not a
		// separate code path, so this asserts the AND rather than trusting it.
		const { dropSocket } = renderApp();
		fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
		expect(windowTitles()).toContain("Buddy List");
		dropSocket();
		expect(windowTitles()).toContain("Sign On");
		expect(windowTitles()).not.toContain("Buddy List");
	});
});
