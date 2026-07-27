import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBuddy, ChatMessage, ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import { ChatWindow, composeHintFor } from "./ChatWindow";
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
	ClassicyWindow: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
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

	it("plays the send sound when a message actually goes", () => {
		const { playSound } = renderChat(1, { enabled: true, reason: "ok" });
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "hey" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(playSound).toHaveBeenCalledWith(IM_SOUNDS.send);
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
});
