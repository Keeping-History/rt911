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
// MediaStreamProvider.flights.test.tsx — this suite doesn't exercise the virtual
// clock or forced-clock enforcement, so a fixed instant + no-op store is enough.
const NOW_ISO = "2001-09-11T13:00:00.000Z";
const FIXED_LOCAL_DATE = new Date(NOW_ISO);
vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({
		localDate: FIXED_LOCAL_DATE,
		dateTime: NOW_ISO,
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
} {
	FakeWebSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeWebSocket);

	const ctxRef: MutableRefObject<MediaStreamContextValue | null> = { current: null };
	render(
		<MediaStreamProvider>
			<ContextBridge bridgeRef={ctxRef} />
			{children}
		</MediaStreamProvider>,
	);
	const ws = FakeWebSocket.instances[0];
	act(() => ws.onopen?.());

	return {
		receive: (bytes: Uint8Array) => {
			ws.onmessage?.(toMessageEvent(bytes));
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
