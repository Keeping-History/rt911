import { act, cleanup, render } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext, type MediaStreamContextValue } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";

const NOW_ISO = "2001-09-11T13:00:00.000Z";
// One stable Date instance — a fresh `new Date(...)` per render infinite-loops
// the tick effect (see MediaStreamProvider.flights.test.tsx).
const FIXED_LOCAL_DATE = new Date(NOW_ISO);
// Flipped by tests, then re-rendered so the mocked hook reports the new value.
let mockPaused = false;
const setDateTimeMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("classicy", () => ({
	// Unlike the other provider test mocks, this one returns `paused` — the
	// whole point of the file.
	useClassicyDateTime: () => ({
		localDate: FIXED_LOCAL_DATE,
		dateTime: NOW_ISO,
		tzOffset: 0,
		setDateTime: setDateTimeMock,
		paused: mockPaused,
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
	useAppManagerDispatch: () => dispatchMock,
	ClassicyIcons: { applications: {} },
	registerApp: () => {},
}));

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

function ContextCapture({
	captured,
}: {
	captured: { current: MediaStreamContextValue | null };
}) {
	const ctx = useContext(MediaStreamContext);
	captured.current = ctx;
	return null;
}

let captured: { current: MediaStreamContextValue | null };

function renderProvider() {
	captured = { current: null };
	// A FRESH element every time, deliberately. React bails out of re-rendering a
	// subtree when handed a referentially identical element, so reusing one
	// `tree` object would skip the component entirely and the mocked hook would
	// never be re-read — the test would silently observe a stale `paused`.
	const tree = () => (
		<MediaStreamProvider>
			<ContextCapture captured={captured} />
		</MediaStreamProvider>
	);
	const result = render(tree());
	return { ...result, again: () => result.rerender(tree()) };
}

/** Frames sent since the marker, so `init` and subscriptions don't pollute assertions. */
const sentSince = (ws: FakeWebSocket, from: number) => ws.sent.slice(from);

beforeEach(() => {
	FakeWebSocket.instances = [];
	mockPaused = false;
	setDateTimeMock.mockClear();
	dispatchMock.mockClear();
	vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("MediaStreamProvider pause/resume frames", () => {
	it("sends pause when the clock is paused", () => {
		const { again } = renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		const mark = ws.sent.length;

		mockPaused = true;
		act(() => {
			again();
		});

		expect(sentSince(ws, mark)).toContain(JSON.stringify({ type: "pause" }));
	});

	it("sends resume when the clock restarts", () => {
		const { again } = renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		mockPaused = true;
		act(() => {
			again();
		});
		const mark = ws.sent.length;

		mockPaused = false;
		act(() => {
			again();
		});

		expect(sentSince(ws, mark)).toContain(JSON.stringify({ type: "resume" }));
	});

	// Today the effect's `[paused]` dependency array alone makes this pass —
	// removing the pauseSentRef equality check does not break it. The check
	// earns its place as the second line of defence: verified by mutation, this
	// test only fails when BOTH the dependency array and the check are gone. It
	// is here so that widening the deps (a plausible future edit — adding
	// `connected`, say) cannot turn a paused clock into a stream of duplicate
	// frames without a test noticing.
	it("sends nothing when paused has not changed", () => {
		const { again } = renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		mockPaused = true;
		act(() => {
			again();
		});
		const mark = ws.sent.length;

		// Same value, two more renders.
		act(() => {
			again();
		});
		act(() => {
			again();
		});

		expect(sentSince(ws, mark)).toEqual([]);
	});

	it("does not announce the default unpaused state on mount", () => {
		// A `resume` for a session that was never paused is meaningless traffic.
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		expect(ws.sent).not.toContain(JSON.stringify({ type: "resume" }));
	});

	it("asserts pause on a connection opened while already paused", () => {
		// The load-bearing case, and an ordinary user action rather than an edge
		// case: `paused` lives in the localStorage-persisted classicyDesktopState,
		// so pausing and reloading the page mounts the provider already paused.
		// onopen sends `init`, which resets Session.paused to false — without this
		// assertion the composer silently re-enables against a frozen clock.
		mockPaused = true;
		renderProvider();
		const ws = FakeWebSocket.instances[0];

		act(() => ws.onopen?.());

		expect(ws.sent).toContain(JSON.stringify({ type: "pause" }));
	});

	it("sends pause after init, not before", () => {
		// init resets Session.paused to false, so a pause that arrives first is
		// immediately undone by the very next frame.
		mockPaused = true;
		renderProvider();
		const ws = FakeWebSocket.instances[0];

		act(() => ws.onopen?.());

		const initAt = ws.sent.findIndex((f) => JSON.parse(f).type === "init");
		const pauseAt = ws.sent.findIndex((f) => JSON.parse(f).type === "pause");
		expect(initAt).toBeGreaterThanOrEqual(0);
		expect(pauseAt).toBeGreaterThan(initAt);
	});

	it("does not assert pause on a connection opened while running", () => {
		renderProvider();
		const ws = FakeWebSocket.instances[0];

		act(() => ws.onopen?.());

		expect(ws.sent).not.toContain(JSON.stringify({ type: "pause" }));
	});
});
