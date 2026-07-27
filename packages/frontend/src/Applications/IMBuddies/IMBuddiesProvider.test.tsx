import { act, cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, MediaStreamContextValue } from "../../Providers/MediaStream/MediaStreamContext";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import { IM_SOUNDS } from "./sounds";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

// --- Controllable virtual clock, shared across a test via a tiny external
// store (so `setClock` from a test can push a new instant into the
// IMBuddiesProvider's useClassicyDateTime() without re-rendering the tree
// from the top). tzOffset is fixed at 0 so localDate === the wire instant,
// keeping the arithmetic in each test's assertions simple.
const DEFAULT_CLOCK_ISO = "2001-09-11T13:00:00Z";
const clockStore = (() => {
	let iso = DEFAULT_CLOCK_ISO;
	const listeners = new Set<() => void>();
	return {
		get: () => iso,
		set: (next: string) => {
			iso = next;
			for (const l of listeners) l();
		},
		reset: () => {
			iso = DEFAULT_CLOCK_ISO;
		},
		subscribe: (cb: () => void) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
})();

// Sound dispatch spy: the real component calls
// soundDispatch({ type: ClassicySoundActionTypes.ClassicySoundPlay, sound }),
// mirroring Alerts.tsx's usage. This mock unwraps that action down to the
// sound name so tests can assert `playSound` was called with an IM_SOUNDS
// value directly.
const mockPlaySound = vi.hoisted(() => vi.fn());

vi.mock("classicy", () => ({
	useSoundDispatch: () => (action: { sound: string }) => mockPlaySound(action.sound),
	ClassicySoundActionTypes: { ClassicySoundPlay: "ClassicySoundPlay" },
	useClassicyDateTime: () => {
		const iso = useSyncExternalStore(clockStore.subscribe, clockStore.get);
		return { localDate: new Date(iso), dateTime: iso, tzOffset: 0 };
	},
}));

import { IMBuddiesProvider, type IMBuddiesValue, useIMBuddies } from "./IMBuddiesProvider";

function IMBridge({ bridgeRef }: { bridgeRef: React.MutableRefObject<IMBuddiesValue | null> }) {
	bridgeRef.current = useIMBuddies();
	return null;
}

interface ChatOverrides {
	chatMessages?: ChatMessage[];
	chatBuddies?: MediaStreamContextValue["chatBuddies"];
	chatEnabled?: boolean;
	chatReason?: MediaStreamContextValue["chatReason"];
	chatTypingProfile?: number | null;
	connected?: boolean;
}

/**
 * Mounts IMBuddiesProvider behind a stubbed MediaStreamContext, exposing:
 * - `ctx`: the live useIMBuddies() value (openChat/send/etc, driven from tests)
 * - `requestChatHistory` / `subscribeChat` / `unsubscribeChat`: spies for the
 *   underlying context calls
 * - `playSound`: the sound-dispatch spy (unwrapped to the sound name)
 * - `setClock`: pushes a new virtual-clock instant into the tree
 * - `pushMessage`: appends a new chat_message-shaped entry to chatMessages,
 *   simulating a live message arriving over the wire
 */
function renderWithChat(children: React.ReactNode, overrides: ChatOverrides) {
	clockStore.reset();
	mockPlaySound.mockClear();

	const requestChatHistory = vi.fn();
	const subscribeChat = vi.fn();
	const unsubscribeChat = vi.fn();
	const sendChat = vi.fn();

	const ctxRef: React.MutableRefObject<IMBuddiesValue | null> = { current: null };
	const pushMessageRef: React.MutableRefObject<
		| ((partial: Partial<ChatMessage> & Pick<ChatMessage, "profile" | "direction" | "body">) => void)
		| null
	> = { current: null };

	function Harness() {
		const [chatMessages, setChatMessages] = useState<ChatMessage[]>(
			overrides.chatMessages ?? [],
		);
		const nextIdRef = useRef(1000);
		// `message_id` may be supplied explicitly (to simulate a history backfill
		// inserting an OLDER id) or omitted (auto-increments, simulating a live
		// message that is always newer than anything seen so far).
		const pushMessage = useCallback(
			(
				partial: Partial<ChatMessage> &
					Pick<ChatMessage, "profile" | "direction" | "body">,
			) => {
				const message_id = partial.message_id ?? (nextIdRef.current += 1);
				setChatMessages((prev) => [
					...prev,
					{ time: "", kind: "generated", ...partial, message_id },
				]);
			},
			[],
		);
		pushMessageRef.current = pushMessage;

		const value = {
			chatBuddies: overrides.chatBuddies ?? [],
			chatEnabled: overrides.chatEnabled ?? true,
			chatReason: overrides.chatReason ?? "ok",
			chatMessages,
			chatTypingProfile: overrides.chatTypingProfile ?? null,
			chatError: null,
			connected: overrides.connected ?? true,
			subscribeChat,
			unsubscribeChat,
			sendChat,
			requestChatHistory,
		} as unknown as MediaStreamContextValue;

		return (
			<MediaStreamContext.Provider value={value}>
				<IMBuddiesProvider>
					<IMBridge bridgeRef={ctxRef} />
					{children}
				</IMBuddiesProvider>
			</MediaStreamContext.Provider>
		);
	}

	const utils = render(<Harness />);

	return {
		...utils,
		get ctx(): IMBuddiesValue {
			if (!ctxRef.current) throw new Error("IMBuddiesContext not captured yet");
			return ctxRef.current;
		},
		requestChatHistory,
		subscribeChat,
		unsubscribeChat,
		playSound: mockPlaySound,
		setClock: (iso: string) => clockStore.set(iso),
		pushMessage: (
			partial: Partial<ChatMessage> & Pick<ChatMessage, "profile" | "direction" | "body">,
		) => pushMessageRef.current?.(partial),
	};
}

function Probe() {
	const im = useIMBuddies();
	return (
		<div>
			<span data-testid="open">{im.openChats.join(",")}</span>
			<span data-testid="unread1">{im.conversationFor(1).unread}</span>
			<span data-testid="msgs1">{im.conversationFor(1).messages.map((m) => m.body).join("|")}</span>
		</div>
	);
}

describe("IMBuddiesProvider", () => {
	it("splits the flat message list per conversation", () => {
		renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
				{ message_id: 2, profile: 2, direction: "out", body: "other", time: "", kind: "generated" },
			],
		});
		expect(screen.getByTestId("msgs1").textContent).toBe("hi");
	});

	it("counts unread for a conversation with no open window", () => {
		renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
			],
		});
		expect(screen.getByTestId("unread1").textContent).toBe("1");
	});

	it("clears unread when the window is opened", () => {
		const { ctx } = renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
			],
		});
		act(() => ctx.openChat(1));
		expect(screen.getByTestId("unread1").textContent).toBe("0");
	});

	it("opening an already-open chat does not duplicate the window", () => {
		const { ctx } = renderWithChat(<Probe />, {});
		act(() => {
			ctx.openChat(1);
			ctx.openChat(1);
		});
		expect(screen.getByTestId("open").textContent).toBe("1");
	});

	it("keeps the transcript when a window closes", () => {
		const { ctx } = renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
			],
		});
		act(() => {
			ctx.openChat(1);
			ctx.closeChat(1);
		});
		expect(screen.getByTestId("msgs1").textContent).toBe("hi");
	});

	it("re-requests history for every open conversation on a backward seek", () => {
		// Seeking back must make a buddy stop remembering what has not happened.
		// shouldSeek() already encodes the asymmetry: forward needs 90s, backward
		// only 2s, because moving back even ten seconds can leave messages from
		// after the new time on screen.
		const { ctx, requestChatHistory, setClock } = renderWithChat(<Probe />, {});
		act(() => {
			ctx.openChat(1);
			ctx.openChat(2);
		});
		requestChatHistory.mockClear();
		act(() => setClock("2001-09-11T12:40:00Z")); // backwards
		expect(requestChatHistory).toHaveBeenCalledTimes(2);
	});

	it("does not re-request history on ordinary forward ticks", () => {
		const { ctx, requestChatHistory, setClock } = renderWithChat(<Probe />, {});
		act(() => ctx.openChat(1));
		requestChatHistory.mockClear();
		act(() => setClock("2001-09-11T13:00:01Z")); // one second later
		expect(requestChatHistory).not.toHaveBeenCalled();
	});

	it("plays the receive sound only for a conversation with no open window", () => {
		// The sound exists to catch a message the student cannot currently see.
		// One for an open window would be noise on top of the message they are
		// already reading.
		const { ctx, playSound, pushMessage } = renderWithChat(<Probe />, {});
		act(() => ctx.openChat(1));
		playSound.mockClear();
		act(() => pushMessage({ profile: 1, direction: "out", body: "seen" }));
		expect(playSound).not.toHaveBeenCalledWith(IM_SOUNDS.receive);
		act(() => pushMessage({ profile: 2, direction: "out", body: "unseen" }));
		expect(playSound).toHaveBeenCalledWith(IM_SOUNDS.receive);
	});

	it("does not play the receive sound for messages already present at mount", () => {
		// Otherwise every reconnect / re-render would replay a chime burst for
		// the whole existing transcript, mirroring presenceRef's prev===null rule.
		const { playSound } = renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 1, profile: 2, direction: "out", body: "hi", time: "", kind: "generated" },
			],
		});
		expect(playSound).not.toHaveBeenCalledWith(IM_SOUNDS.receive);
	});

	it("does not sound the receive chime for a history backfill (an older message inserted after mount)", () => {
		// requestChatHistory's reply inserts OLDER messages into the same flat
		// chatMessages array (a backward seek re-requests backlog, see below).
		// Detecting "new" by message_id — not by array growth — is what keeps
		// that silent: message_id 3 arriving after message_id 10 was already on
		// screen at mount is backfill, not a fresh reply from the buddy.
		const { pushMessage, playSound } = renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 10, profile: 2, direction: "out", body: "recent", time: "", kind: "generated" },
			],
		});
		playSound.mockClear();
		act(() =>
			pushMessage({ message_id: 3, profile: 2, direction: "out", body: "backfilled-older" }),
		);
		expect(playSound).not.toHaveBeenCalledWith(IM_SOUNDS.receive);
	});

	it("does not duplicate an already-open info window", () => {
		// `ctx` is a live getter (re-evaluated on each access, unlike a
		// destructured snapshot) so it reflects state changes from the acts below.
		const result = renderWithChat(<Probe />, {});
		act(() => {
			result.ctx.openInfoFor(3);
			result.ctx.openInfoFor(3);
		});
		expect(result.ctx.openInfo).toEqual([3]);
		act(() => result.ctx.closeInfoFor(3));
		expect(result.ctx.openInfo).toEqual([]);
	});

	it("subscribes on signOn and unsubscribes on signOff", () => {
		const { ctx, subscribeChat, unsubscribeChat } = renderWithChat(<Probe />, {});
		expect(subscribeChat).not.toHaveBeenCalled();
		act(() => ctx.signOn());
		expect(subscribeChat).toHaveBeenCalledWith("IMBuddies.app");
		act(() => ctx.signOff());
		expect(unsubscribeChat).toHaveBeenCalledWith("IMBuddies.app");
	});

	it("clears open windows and read-marks on signOff so the next signOn starts clean", () => {
		const result = renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
			],
		});
		act(() => {
			result.ctx.signOn();
			result.ctx.openChat(1);
		});
		expect(result.ctx.openChats).toEqual([1]);
		act(() => result.ctx.signOff());
		expect(result.ctx.openChats).toEqual([]);
		// A fresh signOn should show the message as unread again (mark reset),
		// not "read" left over from the previous session.
		expect(result.ctx.conversationFor(1).unread).toBe(1);
	});

	it("unsubscribes on unmount while still signed on", () => {
		const { ctx, unmount, unsubscribeChat } = renderWithChat(<Probe />, {});
		act(() => ctx.signOn());
		unmount();
		expect(unsubscribeChat).toHaveBeenCalledWith("IMBuddies.app");
	});

	it("plays the send sound and forwards to sendChat", () => {
		const { ctx, playSound } = renderWithChat(<Probe />, {});
		act(() => ctx.send(1, "hello"));
		expect(playSound).toHaveBeenCalledWith(IM_SOUNDS.send);
	});
});
