import { encode } from "@msgpack/msgpack";
import { act, cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { type MutableRefObject, useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaStreamContextValue } from "./MediaStreamContext";
import { MediaStreamContext } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

// --- WebSocket stub, copied verbatim (shape) from MediaStreamProvider.news.test.tsx
// and MediaStreamProvider.flights.test.tsx — do not invent a second mock shape.
class FakeWebSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static instances: FakeWebSocket[] = [];
	readyState = FakeWebSocket.OPEN;
	binaryType = "";
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	url: string;
	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
}

// Same vi.mock("classicy", ...) stub used by MediaStreamProvider.news.test.tsx /
// MediaStreamProvider.flights.test.tsx. `let`, not `const`: the seek tests
// below advance/rewind the clock by reassigning BOTH of these and re-rendering
// (see setClock). The Date instance must stay stable across renders that don't
// move the clock, or the tick effect re-fires forever.
const NOW_ISO = "2001-09-11T13:00:00.000Z";
let mockDateTime = NOW_ISO;
let mockLocalDate = new Date(NOW_ISO);
vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({
		localDate: mockLocalDate,
		dateTime: mockDateTime,
		tzOffset: 0,
	}),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					DateAndTime: { dateTimeLocked: false },
					Applications: { apps: {} },
				},
			},
		}),
	useAppManagerDispatch: () => vi.fn(),
	ClassicyIcons: { applications: {} },
}));

// Turns an already-msgpack-encoded payload (the return of `encode(...)`) into
// the { data: ArrayBuffer } shape ws.onmessage expects — same conversion the
// other suites' local `frame()` helper does, just taking pre-encoded bytes.
function toMessageEvent(bytes: Uint8Array): { data: ArrayBuffer } {
	return {
		data: bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	};
}

// Captures the live context value into a ref so a test can drive
// subscribeChat/unsubscribeChat/etc directly, without every test needing its
// own probe component for every context field.
function ContextBridge({
	bridgeRef,
}: {
	bridgeRef: MutableRefObject<MediaStreamContextValue | null>;
}) {
	bridgeRef.current = useContext(MediaStreamContext);
	return null;
}

/**
 * Mounts MediaStreamProvider behind a fresh FakeWebSocket, opens the socket,
 * and returns a small harness: `receive` pushes a msgpack-encoded frame,
 * `sent` is the parsed client→server traffic, and `ctx` is the live context
 * value (for calling subscribeChat/sendChat/etc directly in a test).
 */
function renderWithMockSocket(children: React.ReactNode): {
	receive: (bytes: Uint8Array) => void;
	sent: Array<Record<string, unknown>>;
	ctx: MediaStreamContextValue;
	setClock: (iso: string) => void;
} {
	FakeWebSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeWebSocket);
	mockDateTime = NOW_ISO;
	mockLocalDate = new Date(NOW_ISO);

	const ctxRef: MutableRefObject<MediaStreamContextValue | null> = { current: null };
	// A FUNCTION, not a stored element: re-rendering the identical element
	// object lets React bail out of the subtree entirely, so the clock effects
	// would never re-run and a seek test would silently assert nothing.
	const tree = () => (
		<MediaStreamProvider>
			<ContextBridge bridgeRef={ctxRef} />
			{children}
		</MediaStreamProvider>
	);
	const view = render(tree());
	const ws = FakeWebSocket.instances[0];
	act(() => ws.onopen?.());

	return {
		receive: (bytes: Uint8Array) => {
			ws.onmessage?.(toMessageEvent(bytes));
		},
		setClock: (iso: string) => {
			mockDateTime = iso;
			mockLocalDate = new Date(iso);
			view.rerender(tree());
		},
		get sent(): Array<Record<string, unknown>> {
			return ws.sent.map((s) => JSON.parse(s));
		},
		get ctx(): MediaStreamContextValue {
			if (!ctxRef.current) throw new Error("MediaStreamContext not captured yet");
			return ctxRef.current;
		},
	};
}

function Probe() {
	const c = useContext(MediaStreamContext);
	return (
		<div>
			<span data-testid="buddies">{c.chatBuddies.map((b) => b.screen_name).join(",")}</span>
			<span data-testid="reason">{c.chatReason}</span>
			<span data-testid="typing">{String(c.chatTypingProfile)}</span>
			<span data-testid="msgs">{c.chatMessages.map((m) => m.body).join("|")}</span>
		</div>
	);
}

describe("chat channel", () => {
	it("populates the roster from chat_roster", () => {
		const ws = renderWithMockSocket(<Probe />);
		act(() =>
			ws.receive(
				encode({
					type: "chat_roster",
					buddies: [
						{ profile: 1, screen_name: "skaterboi1988", display_name: "Danny", avatar: "", online: true },
					],
				}),
			),
		);
		expect(screen.getByTestId("buddies").textContent).toBe("skaterboi1988");
	});

	it("treats an absent buddies field as an empty roster", () => {
		// chat_roster omits `buddies` entirely when empty — the field rides
		// omitempty because it shares a struct with the 1 Hz items hot path.
		const ws = renderWithMockSocket(<Probe />);
		act(() => ws.receive(encode({ type: "chat_roster" })));
		expect(screen.getByTestId("buddies").textContent).toBe("");
	});

	it("applies chat_presence to an existing buddy without dropping the rest", () => {
		const ws = renderWithMockSocket(<Probe />);
		act(() =>
			ws.receive(
				encode({
					type: "chat_roster",
					buddies: [
						{ profile: 1, screen_name: "a", display_name: "", avatar: "", online: true },
						{ profile: 2, screen_name: "b", display_name: "", avatar: "", online: true },
					],
				}),
			),
		);
		act(() => ws.receive(encode({ type: "chat_presence", profile: 1, online: false })));
		expect(screen.getByTestId("buddies").textContent).toBe("a,b");
	});

	it("clears the typing indicator when the next message lands", () => {
		const ws = renderWithMockSocket(<Probe />);
		act(() => ws.receive(encode({ type: "chat_typing", profile: 1 })));
		expect(screen.getByTestId("typing").textContent).toBe("1");
		act(() =>
			ws.receive(
				encode({
					type: "chat_message",
					profile: 1,
					direction: "out",
					body: "hi",
					time: "2001-09-11T13:00:00Z",
					kind: "generated",
					message_id: 7,
				}),
			),
		);
		expect(screen.getByTestId("typing").textContent).toBe("null");
	});

	it("carries chat_state through, defaulting to not_signed_in before any frame", () => {
		const ws = renderWithMockSocket(<Probe />);
		expect(screen.getByTestId("reason").textContent).toBe("not_signed_in");
		act(() => ws.receive(encode({ type: "chat_state", enabled: true, reason: "ok" })));
		expect(screen.getByTestId("reason").textContent).toBe("ok");
	});

	it("appendLocalChatMessage lands the student's own line in the same array, in order, off the wire", () => {
		// The server never echoes an inbound turn (session.go persists it; every
		// live chat_message frame is direction "out"), so the student's own line
		// is rendered from here. One array means insertion order is the whole
		// ordering rule — no second list to merge — and this must not put a
		// second copy of the message on the wire (sendChat already did that).
		const ws = renderWithMockSocket(<Probe />);
		const sentBefore = ws.sent.length;
		act(() =>
			ws.ctx.appendLocalChatMessage({
				message_id: 0,
				profile: 1,
				direction: "in",
				body: "are you okay",
				time: "2001-09-11T13:00:00.000Z",
				kind: "typed",
			}),
		);
		expect(screen.getByTestId("msgs").textContent).toBe("are you okay");
		expect(ws.sent).toHaveLength(sentBefore);
		act(() =>
			ws.receive(
				encode({
					type: "chat_message",
					profile: 1,
					direction: "out",
					body: "im fine",
					time: "2001-09-11T13:00:05Z",
					kind: "generated",
					message_id: 9,
				}),
			),
		);
		expect(screen.getByTestId("msgs").textContent).toBe("are you okay|im fine");
	});

	it("requestChatHistory drops that profile's local echoes — and only that profile's", () => {
		// chat.HistoryDetailed has no direction filter, so the replay brings the
		// student's own direction:"in" turns back with real message_ids, while
		// an echo's id 0 is exempt from dedupe by design. Nothing would collapse
		// the pair, so the echo must go at request time. The drop lives inside
		// the request so no call site can forget it.
		const ws = renderWithMockSocket(<Probe />);
		act(() => {
			ws.ctx.appendLocalChatMessage({
				message_id: 0,
				profile: 1,
				direction: "in",
				body: "to danny",
				time: "2001-09-11T13:00:00.000Z",
				kind: "typed",
			});
			ws.ctx.appendLocalChatMessage({
				message_id: 0,
				profile: 2,
				direction: "in",
				body: "to carol",
				time: "2001-09-11T13:00:01.000Z",
				kind: "typed",
			});
		});
		expect(screen.getByTestId("msgs").textContent).toBe("to danny|to carol");

		act(() => ws.ctx.requestChatHistory(1, "2001-09-11T13:00:02.000Z", 40));
		// Danny's echo is gone; the replay is authoritative for that
		// conversation. Carol's is untouched — the replay says nothing about it.
		expect(screen.getByTestId("msgs").textContent).toBe("to carol");
		expect(ws.sent.filter((m) => m.type === "chat_history" && m.profile === 1)).toHaveLength(1);
	});

	it("requestChatHistory leaves persisted messages alone", () => {
		// Only id 0 means "local echo". A real persisted line for the same
		// profile must survive the request that is about to re-deliver it — the
		// existing message_id dedupe is what handles that pair.
		const ws = renderWithMockSocket(<Probe />);
		act(() =>
			ws.receive(
				encode({
					type: "chat_message",
					profile: 1,
					direction: "out",
					body: "persisted",
					time: "2001-09-11T13:00:00Z",
					kind: "generated",
					message_id: 42,
				}),
			),
		);
		act(() => ws.ctx.requestChatHistory(1, "2001-09-11T13:00:02.000Z", 40));
		expect(screen.getByTestId("msgs").textContent).toBe("persisted");
	});

	it("clears the transcript on a backward seek so a buddy stops remembering the future", () => {
		// History turns come back as ordinary chat_message frames appended to
		// this same flat array, so without a clear a rewound student still sees
		// every post-seek line with the refetched older lines below them — the
		// exact anachronism the backend's tier system exists to prevent. The
		// neighbouring setNewsItems([]) / setUsenetItems([]) clears in the same
		// effect are there for precisely this reason; chat was left out.
		const ws = renderWithMockSocket(<Probe />);
		act(() =>
			ws.receive(
				encode({
					type: "chat_message",
					profile: 1,
					direction: "out",
					body: "the second tower just went",
					time: "2001-09-11T13:03:00Z",
					kind: "generated",
					message_id: 11,
				}),
			),
		);
		expect(screen.getByTestId("msgs").textContent).toBe("the second tower just went");
		// 20 minutes back, far past BACKWARD_SEEK_THRESHOLD_MS (2s).
		act(() => ws.setClock("2001-09-11T12:40:00.000Z"));
		expect(screen.getByTestId("msgs").textContent).toBe("");
	});

	it("clears a local echo on a backward seek too", () => {
		// The student's own words are just as anachronistic after a rewind as
		// the buddy's; one array means one clear covers both.
		const ws = renderWithMockSocket(<Probe />);
		act(() =>
			ws.ctx.appendLocalChatMessage({
				message_id: 0,
				profile: 1,
				direction: "in",
				body: "are you okay",
				time: "2001-09-11T13:00:00.000Z",
				kind: "typed",
			}),
		);
		act(() => ws.setClock("2001-09-11T12:40:00.000Z"));
		expect(screen.getByTestId("msgs").textContent).toBe("");
	});

	it("keeps the transcript across a FORWARD seek", () => {
		// Forward is not an anachronism: nothing on screen is from after the new
		// instant, and dropping it would blank a conversation a student is in
		// the middle of. The asymmetry is shouldSeek's, not re-derived here.
		const ws = renderWithMockSocket(<Probe />);
		act(() =>
			ws.receive(
				encode({
					type: "chat_message",
					profile: 1,
					direction: "out",
					body: "still here",
					time: "2001-09-11T13:00:30Z",
					kind: "generated",
					message_id: 12,
				}),
			),
		);
		// 20 minutes forward — well past SEEK_THRESHOLD_MS (90s), so this IS a
		// seek; the transcript must survive it anyway.
		act(() => ws.setClock("2001-09-11T13:20:00.000Z"));
		expect(screen.getByTestId("msgs").textContent).toBe("still here");
	});

	it("only sends one subscribe no matter how many apps ask", () => {
		const ws = renderWithMockSocket(<Probe />);
		act(() => {
			ws.ctx.subscribeChat("A");
			ws.ctx.subscribeChat("B");
		});
		expect(ws.sent.filter((m) => m.type === "subscribe" && m.channel === "chat")).toHaveLength(1);
		act(() => ws.ctx.unsubscribeChat("A"));
		expect(ws.sent.filter((m) => m.type === "unsubscribe")).toHaveLength(0);
		act(() => ws.ctx.unsubscribeChat("B"));
		expect(
			ws.sent.filter((m) => m.type === "unsubscribe" && m.channel === "chat"),
		).toHaveLength(1);
	});
});
