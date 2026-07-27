import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBuddy, ChatMessage, ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import { cascadePosition, ChatWindow, composeHintFor } from "./ChatWindow";
import { IM_SOUNDS } from "./sounds";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

describe("composeHintFor", () => {
	it("gives a different sentence per refusal", () => {
		expect(composeHintFor("paused")).toBe("Start the clock to keep talking.");
		expect(composeHintFor("outside_window")).toBe("Nobody is online right now.");
		expect(composeHintFor("blocked")).toBe("You can't send messages right now.");
		expect(composeHintFor("ok")).toBe("");
	});
});

// --- Mutable state the mocked useIMBuddies() reads from, set per-test by
// renderChat(). Hoisted so the vi.mock() factory (which runs before the rest
// of this module) can close over it.
const imState = vi.hoisted(() => ({
	buddies: [] as ChatBuddy[],
	enabled: true,
	reason: "ok" as ChatStateReason,
	messages: [] as ChatMessage[],
	typingProfile: null as number | null,
	send: vi.fn(),
	markRead: vi.fn(),
	closeChat: vi.fn(),
}));

// Captures every sound name played through useSoundDispatch(), same shape as
// the { type, sound } action ClassicySoundActionTypes.ClassicySoundPlay uses
// elsewhere in this app (see Alerts.tsx / SignOnWindow.tsx).
const playSoundSpy = vi.hoisted(() => vi.fn());

vi.mock("./IMBuddiesProvider", () => ({
	useIMBuddies: () => ({
		buddies: imState.buddies,
		enabled: imState.enabled,
		reason: imState.reason,
		conversationFor: (profile: number) => ({
			messages: imState.messages.filter((m) => m.profile === profile),
			unread: 0,
		}),
		typingProfile: imState.typingProfile,
		send: imState.send,
		markRead: imState.markRead,
		closeChat: imState.closeChat,
	}),
}));

// Partial classicy mock: ClassicyWindow requires a real
// ClassicyAppManagerProvider tree to render its children (same as
// BuddyListWindow.test.tsx/SignOnWindow.test.tsx), so it alone is stubbed to
// a plain passthrough div. ClassicyInput and ClassicyButton are left as the
// REAL components — this file's assertions (field clears, disabled state,
// no chirp on an empty send) are about ChatWindow's own logic, and both real
// components' sound/analytics hooks (`tq()`/`useSoundDispatch`) already
// no-op safely without a provider (verified against classicy's source),
// so nothing here needs a stub to avoid throwing.
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	// `title` is surfaced as text, standing in for the real title bar: the
	// window is titled with the buddy's name, and a wrong-buddy lookup would
	// mis-title it as surely as it would misattribute a line.
	ClassicyWindow: (props: { title?: string; children?: React.ReactNode }) => (
		<div>
			<div data-testid="window-title">{props.title}</div>
			{props.children}
		</div>
	),
	useSoundDispatch: () => (action: { type: string; sound: string }) => {
		if (action.type === "ClassicySoundPlay") playSoundSpy(action.sound);
	},
	ClassicySoundActionTypes: { ClassicySoundPlay: "ClassicySoundPlay" },
}));

function renderChat(
	profile: number,
	overrides: {
		enabled?: boolean;
		reason?: ChatStateReason;
		typingProfile?: number | null;
		messages?: ChatMessage[];
		buddies?: ChatBuddy[];
	} = {},
) {
	imState.buddies = overrides.buddies ?? [
		{ profile, screen_name: "buddy" + profile, display_name: "Buddy " + profile, avatar: "", online: true },
	];
	imState.enabled = overrides.enabled ?? true;
	imState.reason = overrides.reason ?? "ok";
	imState.messages = overrides.messages ?? [];
	imState.typingProfile = overrides.typingProfile ?? null;
	imState.send = vi.fn();
	imState.markRead = vi.fn();
	imState.closeChat = vi.fn();
	playSoundSpy.mockClear();
	render(<ChatWindow profile={profile} />);
	return { send: imState.send, playSound: playSoundSpy, markRead: imState.markRead };
}

describe("ChatWindow", () => {
	it("sends on Enter and clears the field", () => {
		const { send } = renderChat(1, { enabled: true, reason: "ok" });
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "hey" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(send).toHaveBeenCalledWith(1, "hey");
		expect((input as HTMLInputElement).value).toBe("");
	});

	it("does not send an empty message", () => {
		const { send, playSound } = renderChat(1, { enabled: true, reason: "ok" });
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		expect(send).not.toHaveBeenCalled();
		// and no sound either -- a keystroke that does nothing must not chirp
		expect(playSound).not.toHaveBeenCalled();
	});

	it("does not play the send sound itself -- IMBuddiesProvider.send already does", () => {
		// This file mocks useIMBuddies(), so its stubbed `send` never actually
		// calls `play`. That's deliberate: IMBuddiesProvider.send is the one
		// place IM_SOUNDS.send gets played (see IMBuddiesProvider.test.tsx). A
		// duplicate `play(IM_SOUNDS.send)` here would double-chirp every real
		// send without this test (or the mocked `send` above) ever catching
		// it -- so this asserts ChatWindow stays out of that business, and the
		// end-to-end "exactly once" guarantee remains the provider's test.
		const { playSound } = renderChat(1, { enabled: true, reason: "ok" });
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "hey" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(playSound).not.toHaveBeenCalledWith(IM_SOUNDS.send);
	});

	it("disables compose and explains why when the clock is paused", () => {
		renderChat(1, { enabled: false, reason: "paused" });
		expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
		expect(screen.getByText("Start the clock to keep talking.")).toBeTruthy();
	});

	it("shows the typing indicator only for its own buddy", () => {
		renderChat(1, { enabled: true, reason: "ok", typingProfile: 2 });
		expect(screen.queryByText(/is typing/)).toBeNull();
	});

	it("renders a stall message as the buddy speaking", () => {
		// Queue-full arrives as a normal chat_message with kind "stall". It is
		// meant to read as the buddy, so it gets no special treatment.
		renderChat(1, {
			enabled: true,
			reason: "ok",
			messages: [
				{
					message_id: 1,
					profile: 1,
					direction: "out",
					body: "hang on, phones ringing",
					time: "",
					kind: "stall",
				},
			],
		});
		expect(screen.getByText(/hang on, phones ringing/)).toBeTruthy();
	});

	it("attributes each message to the right speaker -- 'out' is the buddy, 'in' is the student", () => {
		// Per packages/backend/docs/websocket-protocol.md's chat_message field
		// table: direction "in" is student -> buddy, "out" is buddy -> student.
		// Getting this backwards puts the student's own words in the mouth of a
		// September 11 character -- the single most user-visible way this
		// window can be wrong -- so this asserts the pairing, not just that
		// both strings appear somewhere on the page.
		renderChat(1, {
			enabled: true,
			reason: "ok",
			buddies: [{ profile: 1, screen_name: "danny99", display_name: "Danny", avatar: "", online: true }],
			messages: [
				{ message_id: 1, profile: 1, direction: "out", body: "the tower is on fire", time: "", kind: "generated" },
				{ message_id: 2, profile: 1, direction: "in", body: "are you okay", time: "", kind: "typed" },
			],
		});
		const buddyLine = screen.getByText(/the tower is on fire/).closest("div");
		const studentLine = screen.getByText(/are you okay/).closest("div");
		expect(buddyLine?.textContent).toMatch(/^Danny:/);
		expect(studentLine?.textContent).toMatch(/^You:/);
	});

	it("names the buddy from the `profile` prop, not the first buddy on the roster", () => {
		// Every other test in this file renders with profile=1 AND builds its
		// roster from that same argument, so a lookup that ignored the prop and
		// reached for buddies[0] would pass all of them — including the speaker
		// attribution test above, which is the most user-visible thing this
		// window can get wrong. InfoWindow had exactly this blind spot and was
		// fixed; this is the mirror of that fix. Two buddies, and Carol
		// (profile 2, deliberately NOT buddies[0]) is the one rendered.
		renderChat(2, {
			buddies: [
				{ profile: 1, screen_name: "danny99", display_name: "Danny", avatar: "", online: true },
				{ profile: 2, screen_name: "carolm", display_name: "Carol", avatar: "", online: true },
			],
			typingProfile: 2,
			messages: [
				{ message_id: 1, profile: 2, direction: "out", body: "im at my desk", time: "", kind: "generated" },
			],
		});
		expect(screen.getByTestId("window-title").textContent).toBe("Carol");
		const buddyLine = screen.getByText(/im at my desk/).closest("div");
		expect(buddyLine?.textContent).toMatch(/^Carol:/);
		expect(screen.getByText("Carol is typing...")).toBeTruthy();
		// Danny must not appear anywhere — not as the title, not as a speaker.
		expect(screen.queryByText(/Danny/)).toBeNull();
	});
});

describe("cascadePosition", () => {
	it("puts each successive window somewhere else", () => {
		// #318: every chat window opened at ["center","center"], so the second
		// buddy's window landed pixel-perfect on the first and the app looked
		// like it reused one window for every conversation. No test could see
		// it, because every test rendered exactly one window.
		expect(cascadePosition(0)).not.toEqual(cascadePosition(1));
		expect(cascadePosition(1)).not.toEqual(cascadePosition(2));
	});

	it("wraps rather than walking windows off the screen", () => {
		// Six steps then back to the start: a student with many conversations
		// open should not have the seventh window land past the desktop edge.
		expect(cascadePosition(6)).toEqual(cascadePosition(0));
	});

	it("moves both axes together, the way a Mac OS 8 cascade does", () => {
		const [x, y] = cascadePosition(3);
		const [x0, y0] = cascadePosition(0);
		expect(x).toBeGreaterThan(x0);
		expect(y).toBeGreaterThan(y0);
	});
});
