import { encode } from "@msgpack/msgpack";
import { act, cleanup, render } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext, type MediaStreamContextValue } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";

// Fixed virtual clock: 2001-09-11T13:00:00Z, no display-tz offset, so
// virtualUtcMs(localDate, 0) === 13:00 UTC exactly.
const NOW_ISO = "2001-09-11T13:00:00.000Z";
// Hoisted to a single stable Date instance — see MediaStreamProvider.flights.test.tsx
// for why a fresh `new Date(...)` per render would infinite-loop the tick effect.
let mockDateTime = NOW_ISO;
const FIXED_LOCAL_DATE = new Date(NOW_ISO);
const setDateTimeMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
const mockApps = vi.hoisted(() => ({
	current: {} as Record<string, { open?: boolean; name?: string; icon?: string }>,
}));
vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({
		localDate: FIXED_LOCAL_DATE,
		dateTime: mockDateTime,
		tzOffset: 0,
		setDateTime: setDateTimeMock,
	}),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					DateAndTime: { dateTimeLocked: false },
					Applications: { apps: mockApps.current },
				},
			},
		}),
	useAppManagerDispatch: () => dispatchMock,
	// playlistAppMeta (used by the Time Machine force-close effect) reads this
	// for icon lookup; an empty registry resolves to icon: "" harmlessly.
	ClassicyIcons: { applications: {} },
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

function frame(payload: object): { data: ArrayBuffer } {
	const bytes = encode(payload);
	return {
		data: bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	};
}

// Captures the live context value into an external ref on every render, so
// the test can drive frames directly via act() instead of relying on
// effect-cleanup ordering across an unmount.
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
	render(
		<MediaStreamProvider>
			<ContextCapture captured={captured} />
		</MediaStreamProvider>,
	);
}

describe("MediaStreamProvider clock/heartbeat_ack", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		mockDateTime = NOW_ISO;
		setDateTimeMock.mockClear();
		dispatchMock.mockClear();
		mockApps.current = {};
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	describe("forced clock", () => {
		it("clock frame with active:true jumps the clock and sets clockForced", () => {
			renderProvider();
			const ws = FakeWebSocket.instances[0];
			act(() => ws.onopen?.());

			act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));

			expect(setDateTimeMock).toHaveBeenCalledTimes(1);
			expect((setDateTimeMock.mock.calls[0][0] as Date).toISOString()).toBe("2001-09-11T14:00:00.000Z");
			expect(captured.current?.clockForced).toBe(true);
		});

		it("clock frame within the drift threshold does not touch the clock", () => {
			renderProvider();
			const ws = FakeWebSocket.instances[0];
			act(() => ws.onopen?.());

			// 1 s ahead of NOW_ISO — under FORCED_DRIFT_THRESHOLD_MS.
			act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T13:00:01Z" })));

			expect(setDateTimeMock).not.toHaveBeenCalled();
			expect(captured.current?.clockForced).toBe(true);
		});

		it("heartbeat_ack.master_time corrects drift beyond the threshold", () => {
			renderProvider();
			const ws = FakeWebSocket.instances[0];
			act(() => ws.onopen?.());

			act(() => ws.onmessage?.(frame({ type: "heartbeat_ack", time: "x", master_time: "2001-09-11T13:00:05Z" })));

			expect(setDateTimeMock).toHaveBeenCalledTimes(1);
			expect(captured.current?.clockForced).toBe(true);
		});

		it("heartbeat_ack without master_time clears clockForced (release self-heal)", () => {
			renderProvider();
			const ws = FakeWebSocket.instances[0];
			act(() => ws.onopen?.());

			act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));
			expect(captured.current?.clockForced).toBe(true);

			act(() => ws.onmessage?.(frame({ type: "heartbeat_ack", time: "2001-09-11T14:00:30Z" })));
			expect(captured.current?.clockForced).toBe(false);
		});

		it("clock frame with active:false clears clockForced without moving the clock", () => {
			renderProvider();
			const ws = FakeWebSocket.instances[0];
			act(() => ws.onopen?.());

			act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));
			setDateTimeMock.mockClear();

			act(() => ws.onmessage?.(frame({ type: "clock", active: false })));
			expect(captured.current?.clockForced).toBe(false);
			expect(setDateTimeMock).not.toHaveBeenCalled();
		});
	});

	describe("forced clock enforcement", () => {
		it("locks and unlocks the Date & Time editors with forced mode", () => {
			renderProvider();
			const ws = FakeWebSocket.instances[0];
			act(() => ws.onopen?.());

			act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));
			expect(dispatchMock).toHaveBeenCalledWith({ type: "ClassicyManagerDateTimeLock" });

			act(() => ws.onmessage?.(frame({ type: "clock", active: false })));
			expect(dispatchMock).toHaveBeenCalledWith({ type: "ClassicyManagerDateTimeUnlock" });
		});

		it("force-closes Time Machine while forced", () => {
			mockApps.current = { "TimeMachine.app": { open: true, name: "Time Machine", icon: "tm.png" } };
			renderProvider();
			const ws = FakeWebSocket.instances[0];
			act(() => ws.onopen?.());

			act(() => ws.onmessage?.(frame({ type: "clock", active: true, time: "2001-09-11T14:00:00Z" })));

			expect(dispatchMock).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "ClassicyAppClose",
					app: expect.objectContaining({ id: "TimeMachine.app" }),
				}),
			);
		});

		it("does not touch Time Machine when not forced", () => {
			mockApps.current = { "TimeMachine.app": { open: true, name: "Time Machine", icon: "tm.png" } };
			renderProvider();
			const ws = FakeWebSocket.instances[0];
			act(() => ws.onopen?.());

			const closes = dispatchMock.mock.calls.filter((c) => c[0]?.type === "ClassicyAppClose");
			expect(closes).toHaveLength(0);
		});
	});
});
