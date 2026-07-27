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
// Display-timezone offset the mocked useClassicyDateTime reports. Default 0 so
// localDate === the wire instant for the clock/seek tests; one test raises it
// to prove the local echo's timestamp goes through virtualUtcMs rather than
// shipping the display value.
const tzOffsetStore = { hours: 0 };
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

// Window-focus spy: openChat raises an ALREADY-open chat window (#324), which
// is the only case a dispatch can reach — a window opening for the first time
// focuses itself on mount, where this provider cannot see it.
const mockDesktopDispatch = vi.hoisted(() => vi.fn());
// Whether the mocked classicy reports the boot splash as already shown. Auto
// sign-on (#321) keys off this, so it defaults to false and the one test that
// exercises that path turns it on.
const startupScreenStore = vi.hoisted(() => ({ shown: false }));

vi.mock("classicy", () => ({
	useSoundDispatch: () => (action: { sound: string }) => mockPlaySound(action.sound),
	ClassicySoundActionTypes: { ClassicySoundPlay: "ClassicySoundPlay" },
	useAppManagerDispatch: () => mockDesktopDispatch,
	hasShownStartupScreenThisSession: () => startupScreenStore.shown,
	useClassicyDateTime: () => {
		const iso = useSyncExternalStore(clockStore.subscribe, clockStore.get);
		return { localDate: new Date(iso), dateTime: iso, tzOffset: tzOffsetStore.hours };
	},
}));

// The provider reads the Directus session to decide whether auto sign-on is
// even allowed. Signed out by default: a signed-out student must never be
// signed on automatically (they would land in the Account app unasked).
const authStore = vi.hoisted(() => ({ user: null as { username?: string } | null }));
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => ({ user: authStore.user }),
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
	tzOffset?: number;
	/** Directus session. Null (signed out) unless a test says otherwise. */
	user?: { username?: string } | null;
	/** Whether classicy reports the boot splash as already shown (#321). */
	startupScreenShown?: boolean;
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
	tzOffsetStore.hours = overrides.tzOffset ?? 0;
	mockPlaySound.mockClear();
	mockDesktopDispatch.mockClear();
	// Signed out and pre-splash by default, so no test signs on by accident:
	// auto sign-on (#321) needs BOTH, and a test that quietly connected would
	// make every "not signed on yet" assertion below meaningless.
	authStore.user = overrides.user ?? null;
	startupScreenStore.shown = overrides.startupScreenShown ?? false;

	const requestChatHistory = vi.fn();
	const subscribeChat = vi.fn();
	const unsubscribeChat = vi.fn();
	const sendChat = vi.fn();
	// Records every locally-echoed line, so a test can assert on the exact
	// ChatMessage the provider handed to MediaStreamProvider (not just on what
	// ends up rendered).
	const localEchoes: ChatMessage[] = [];

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

		// Stands in for MediaStreamProvider's real appendLocalChatMessage: the
		// student's own turn is never echoed by the server (session.go only
		// persists it; live chat_message frames are all direction "out"), so it
		// lands in the SAME chatMessages array as server frames — one ordered
		// list, no invented merge.
		const appendLocalChatMessage = useCallback((message: ChatMessage) => {
			localEchoes.push(message);
			setChatMessages((prev) => [...prev, message]);
		}, []);

		// Mirrors the REAL requestChatHistory, which drops that profile's local
		// echoes before asking (MediaStreamProvider.tsx). The drop is folded
		// into the request there precisely so no call site can forget it; this
		// three-line filter is the same rule, and
		// MediaStreamProvider.chat.test.tsx pins the real one independently so
		// this stub cannot quietly become more forgiving than the thing it
		// stands in for.
		const requestChatHistoryStub = useCallback(
			(profile: number, before: string, limit: number) => {
				setChatMessages((prev) =>
					prev.filter((m) => !(m.message_id === 0 && m.profile === profile)),
				);
				requestChatHistory(profile, before, limit);
			},
			[],
		);

		const value = {
			chatBuddies: overrides.chatBuddies ?? [],
			chatEnabled: overrides.chatEnabled ?? true,
			chatReason: overrides.chatReason ?? "ok",
			chatMessages,
			chatTypingProfile: overrides.chatTypingProfile ?? null,
			connected: overrides.connected ?? true,
			subscribeChat,
			unsubscribeChat,
			sendChat,
			requestChatHistory: requestChatHistoryStub,
			appendLocalChatMessage,
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
		sendChat,
		localEchoes,
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
			<span data-testid="dirs1">
				{im.conversationFor(1).messages.map((m) => `${m.direction}:${m.body}`).join("|")}
			</span>
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

	it("dedupes a message re-delivered by a history re-fetch (same message_id)", () => {
		// websocket-protocol.md: message_id is "echoed so a client can dedupe".
		// MediaStreamProvider appends unconditionally, so a backward seek's
		// history re-fetch resending an already-live message must be collapsed
		// here, not shown twice.
		const { pushMessage } = renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 5, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
			],
		});
		act(() => pushMessage({ message_id: 5, profile: 1, direction: "out", body: "hi" }));
		expect(screen.getByTestId("msgs1").textContent).toBe("hi");
	});

	it("never dedupes id-0 messages — two distinct id-0 messages both survive", () => {
		// message_id is 0 when persistence was skipped server-side (no db
		// pool). It's not a real identity, so treating repeated 0s as
		// duplicates would silently collapse unrelated messages.
		renderWithChat(<Probe />, {
			chatMessages: [
				{ message_id: 0, profile: 1, direction: "out", body: "first", time: "", kind: "generated" },
				{ message_id: 0, profile: 1, direction: "out", body: "second", time: "", kind: "generated" },
			],
		});
		expect(screen.getByTestId("msgs1").textContent).toBe("first|second");
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

	it("treats a 30s backward seek as a seek — pinning the forward/backward asymmetry", () => {
		// This is the case a hand-rolled `Math.abs(delta) > 90_000` symmetric
		// check gets WRONG: 30s is within shouldSeek's 2s backward bound (a
		// seek) but also within its 90s forward bound, so a symmetric mutant
		// would treat it as NOT a seek. The 20-minute test above trips both the
		// correct and the wrong threshold and so cannot tell them apart on its
		// own — this test is the one that actually pins shouldSeek's asymmetry.
		const { ctx, requestChatHistory, setClock } = renderWithChat(<Probe />, {});
		act(() => ctx.openChat(1));
		requestChatHistory.mockClear();
		act(() => setClock("2001-09-11T12:59:30Z")); // 30s backward
		expect(requestChatHistory).toHaveBeenCalledTimes(1);
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

	it("retargets the one info window instead of opening a second (#325)", () => {
		// `ctx` is a live getter (re-evaluated on each access, unlike a
		// destructured snapshot) so it reflects state changes from the acts below.
		const result = renderWithChat(<Probe />, {});
		act(() => result.ctx.openInfoFor(3));
		expect(result.ctx.infoProfile).toBe(3);

		// The bug this replaces: openInfoFor appended, so asking for a second
		// buddy's info opened a SECOND window at the same centred position,
		// behind the first — and pressing Info looked like it did nothing.
		act(() => result.ctx.openInfoFor(7));
		expect(result.ctx.infoProfile).toBe(7);

		act(() => result.ctx.closeInfo());
		expect(result.ctx.infoProfile).toBeNull();
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
		const { ctx, playSound, sendChat } = renderWithChat(<Probe />, {});
		act(() => ctx.send(1, "hello"));
		expect(playSound).toHaveBeenCalledWith(IM_SOUNDS.send);
		expect(sendChat).toHaveBeenCalledWith(1, "hello");
	});

	it("shows the student's own message in its own conversation, as direction 'in'", () => {
		// The server never echoes the inbound turn — session.go's persistInbound
		// only writes it, and every live chat_message frame is direction "out"
		// ("in" comes back solely through chat_history replay). Without a local
		// echo the student types, the field clears, and their words vanish.
		const { ctx } = renderWithChat(<Probe />, {});
		act(() => ctx.send(1, "are you okay"));
		expect(screen.getByTestId("dirs1").textContent).toBe("in:are you okay");
	});

	it("keeps the local echo in the conversation it was sent to, not everyone's", () => {
		const { ctx } = renderWithChat(<Probe />, {});
		act(() => ctx.send(2, "meant for carol"));
		expect(screen.getByTestId("msgs1").textContent).toBe("");
	});

	it("interleaves the local echo with server frames in send order", () => {
		// One ordered array is what keeps this right without inventing a merge:
		// a reply that lands after the student's line must render after it.
		const { ctx, pushMessage } = renderWithChat(<Probe />, {});
		act(() => ctx.send(1, "are you okay"));
		act(() => pushMessage({ profile: 1, direction: "out", body: "im fine" }));
		expect(screen.getByTestId("msgs1").textContent).toBe("are you okay|im fine");
	});

	it("stamps the local echo with the virtual UTC instant, not the display clock", () => {
		// Hard rule 3: virtualUtcMs(localDate, tzOffset), never a raw localDate.
		// With a -4 display offset the two differ by four hours, so shipping
		// localDate here would put the student's own line four hours into the
		// future of the conversation it joins.
		const { ctx, localEchoes } = renderWithChat(<Probe />, { tzOffset: -4 });
		act(() => ctx.send(1, "hi"));
		expect(localEchoes).toHaveLength(1);
		// No fractional seconds, deliberately (#327): the streamer formats every
		// chat_message time with Go's time.RFC3339, which has none. A
		// millisecond-precise echo compared against those truncated values always
		// looked LATER within the same second, so the student's own line sorted
		// below the reply to it.
		expect(localEchoes[0].time).toBe("2001-09-11T17:00:00Z");
		expect(localEchoes[0].kind).toBe("typed");
		// id 0 means "not persisted" — it must stay out of the dedupe path, or
		// two typed lines in a row would collapse into one.
		expect(localEchoes[0].message_id).toBe(0);
	});

	it("does not collapse two identical typed lines (both carry the non-identity id 0)", () => {
		const { ctx } = renderWithChat(<Probe />, {});
		act(() => ctx.send(1, "hello?"));
		act(() => ctx.send(1, "hello?"));
		expect(screen.getByTestId("msgs1").textContent).toBe("hello?|hello?");
	});

	it("requests history when a chat window is opened, so a post-seek reopen refills", () => {
		// A backward seek clears the whole transcript in MediaStreamProvider.
		// The seek effect below only re-requests history for conversations that
		// were ALREADY open, so without this a conversation reopened after a
		// rewind would show a permanently empty window.
		const { ctx, requestChatHistory } = renderWithChat(<Probe />, {});
		act(() => ctx.openChat(4));
		expect(requestChatHistory).toHaveBeenCalledWith(4, expect.any(String), expect.any(Number));
	});

	// --- A local echo must never coexist with its persisted copy.
	//
	// chat.HistoryDetailed (packages/backend/internal/chat/store.go) has NO
	// direction filter, so a replay brings the student's own direction:"in"
	// turns back with real message_ids — while the id-0 echo is exempt from
	// dedupe by design. The backward-seek path is safe only because
	// MediaStreamProvider clears the transcript first. These two paths do not
	// clear, and both were introduced/made-reachable by the local-echo work.

	it("does not duplicate the student's line when a FORWARD seek replays history", () => {
		// A forward seek re-requests history for every open conversation but
		// (correctly) does not clear the transcript — so without dropping the
		// echo, the replayed persisted copy lands beside it.
		const { ctx, pushMessage, setClock } = renderWithChat(<Probe />, {});
		act(() => ctx.openChat(1));
		act(() => ctx.send(1, "are you okay"));
		act(() => setClock("2001-09-11T13:20:00Z")); // 20 min forward — a seek
		// The replay of the persisted copy of that very line.
		act(() =>
			pushMessage({ message_id: 77, profile: 1, direction: "in", body: "are you okay" }),
		);
		expect(screen.getByTestId("msgs1").textContent).toBe("are you okay");
	});

	it("does not duplicate the student's line when a chat is closed and reopened", () => {
		const { ctx, pushMessage } = renderWithChat(<Probe />, {});
		act(() => ctx.openChat(1));
		act(() => ctx.send(1, "are you okay"));
		act(() => ctx.closeChat(1));
		act(() => ctx.openChat(1));
		act(() =>
			pushMessage({ message_id: 77, profile: 1, direction: "in", body: "are you okay" }),
		);
		expect(screen.getByTestId("msgs1").textContent).toBe("are you okay");
	});

	it("drops only the requested profile's echoes, leaving another conversation alone", () => {
		// The replay is authoritative for ONE conversation. Opening Danny's
		// window must not swallow what the student said to Carol.
		const { ctx } = renderWithChat(<Probe />, {});
		act(() => ctx.send(1, "to danny"));
		act(() => ctx.openChat(2));
		expect(screen.getByTestId("msgs1").textContent).toBe("to danny");
	});

	it("orders a history replay by virtual time, not by arrival", () => {
		// History arrives oldest-first and is appended to the same flat array,
		// so a live beat received while the window was closed would otherwise
		// sit ABOVE the older lines the replay brings in — a student opening a
		// conversation for the first time sees it scrambled.
		const { ctx, pushMessage } = renderWithChat(<Probe />, {});
		act(() =>
			pushMessage({
				message_id: 50,
				profile: 1,
				direction: "out",
				body: "newest",
				time: "2001-09-11T13:03:00Z",
			}),
		);
		act(() => ctx.openChat(1));
		act(() =>
			pushMessage({
				message_id: 30,
				profile: 1,
				direction: "out",
				body: "older",
				time: "2001-09-11T12:50:00Z",
			}),
		);
		expect(screen.getByTestId("msgs1").textContent).toBe("older|newest");
	});

	it("keeps two messages from the same virtual second in arrival order", () => {
		// The sort tiebreak must be stable: a conversation moves faster than
		// the one-second resolution of virtual_time, and two lines in the same
		// second swapping places would reorder a question and its answer.
		const { pushMessage } = renderWithChat(<Probe />, {});
		const time = "2001-09-11T13:03:00Z";
		act(() => pushMessage({ message_id: 0, profile: 1, direction: "in", body: "first", time }));
		act(() => pushMessage({ message_id: 0, profile: 1, direction: "in", body: "second", time }));
		expect(screen.getByTestId("msgs1").textContent).toBe("first|second");
	});

	it("does not chime the receive sound for the student's own echo", () => {
		const { ctx, playSound } = renderWithChat(<Probe />, {});
		playSound.mockClear();
		act(() => ctx.send(1, "hi"));
		expect(playSound).not.toHaveBeenCalledWith(IM_SOUNDS.receive);
	});

	it("keeps a sent line above a reply stamped in the same second (#327)", () => {
		// The reported bug: the student's own message appeared BELOW the buddy's
		// answer to it. The echo carried milliseconds while the server's reply
		// carried whole-second RFC3339, so within one second the echo always
		// compared later. Both sides must now be at the same resolution, leaving
		// arrival order to decide.
		const { ctx, pushMessage, setClock } = renderWithChat(<Probe />, {});
		// A fractional instant is the whole point: on an exact second boundary
		// "…:00.000Z" and "…:00Z" parse to the same value and the bug cannot
		// reproduce, so a test written at 13:00:00 passes against the broken
		// code too. Mutation testing caught exactly that.
		act(() => setClock("2001-09-11T13:00:00.250Z"));
		act(() => ctx.send(1, "are you okay"));
		act(() =>
			pushMessage({
				message_id: 42,
				profile: 1,
				direction: "out",
				body: "im fine",
				// The same virtual second, at the whole-second resolution the
				// streamer actually formats with (Go time.RFC3339).
				time: "2001-09-11T13:00:00Z",
			}),
		);
		expect(screen.getByTestId("msgs1").textContent).toBe("are you okay|im fine");
	});

	it("signs on by itself once the startup screen has been shown (#321)", () => {
		const { ctx, subscribeChat } = renderWithChat(<Probe />, {
			user: { username: "student" },
			startupScreenShown: true,
		});
		expect(ctx.connected).toBe(true);
		expect(subscribeChat).toHaveBeenCalled();
	});

	it("never auto signs on a signed-out student (#321)", () => {
		// The guard that matters most: SignOnWindow hands a signed-out student
		// to the Account app, so auto-firing this would drop someone into a
		// login screen they never asked for, on boot.
		const { ctx, subscribeChat } = renderWithChat(<Probe />, {
			user: null,
			startupScreenShown: true,
		});
		expect(ctx.connected).toBe(false);
		expect(subscribeChat).not.toHaveBeenCalled();
	});

	it("does not auto sign on before the startup screen has been shown (#321)", () => {
		const { ctx } = renderWithChat(<Probe />, {
			user: { username: "student" },
			startupScreenShown: false,
		});
		expect(ctx.connected).toBe(false);
	});

	it("stays signed off after an explicit Sign Off (#321)", () => {
		// Without the latch the auto sign-on effect re-fires the moment signedOn
		// flips false, and Sign Off becomes a button that cannot be obeyed.
		// `result.ctx`, not a destructured `ctx`: the getter is re-evaluated on
		// each access, and a snapshot taken before signOff would still report
		// the old value and pass no matter what the latch did.
		const result = renderWithChat(<Probe />, {
			user: { username: "student" },
			startupScreenShown: true,
		});
		expect(result.ctx.connected).toBe(true);
		act(() => result.ctx.signOff());
		expect(result.ctx.connected).toBe(false);
	});

	it("raises an already-open chat window rather than doing nothing (#324)", () => {
		const { ctx } = renderWithChat(<Probe />, {});
		act(() => ctx.openChat(5));
		expect(mockDesktopDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ClassicyWindowFocus",
				window: { id: "im_chat_5" },
			}),
		);
	});
});
