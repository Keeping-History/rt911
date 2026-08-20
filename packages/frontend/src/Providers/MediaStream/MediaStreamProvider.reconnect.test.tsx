import { act, cleanup, render } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";
import { reconnectDelayMs } from "./reconnectBackoff";

// Fixed virtual clock; see MediaStreamProvider.flights.test.tsx for why this
// must be one stable Date instance rather than a fresh one per render.
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
	registerApp: () => {},
}));

class FakeWebSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	readyState = FakeWebSocket.OPEN;
	binaryType = "";
	sent: string[] = [];
	closed = false;
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
	close() {
		this.closed = true;
		this.readyState = FakeWebSocket.CLOSED;
	}
	/** Simulate the server going away (pod roll, network blip, laptop sleep). */
	drop() {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
}

function FlightsConsumer() {
	const { subscribeFlights } = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeFlights("test.app");
	}, [subscribeFlights]);
	return null;
}

const renderProvider = () =>
	render(
		<MediaStreamProvider>
			<FlightsConsumer />
		</MediaStreamProvider>,
	);

const subscribedTo = (ws: FakeWebSocket, channel: string) =>
	ws.sent.some((f) => f === JSON.stringify({ type: "subscribe", channel }));

beforeEach(() => {
	FakeWebSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeWebSocket);
	vi.useFakeTimers();
});
afterEach(() => {
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
	cleanup();
	vi.unstubAllGlobals();
});

// The streamer is redeployed on every merge to main, and each rollout drops
// every open socket. Before this, `onclose` only flipped `connected` to false:
// nothing ever constructed a second WebSocket, so the carefully-written
// resubscribe block in `onopen` could only run on the initial mount. Every
// later send() no-oped on a CLOSED socket, which is why seeking could not
// recover a Flight Tracker that had gone empty — only a page reload could.
describe("MediaStreamProvider reconnect", () => {
	it("opens a new socket after the connection drops", () => {
		renderProvider();
		const first = FakeWebSocket.instances[0];
		act(() => first.onopen?.());

		act(() => first.drop());
		act(() => {
			vi.advanceTimersByTime(30_000);
		});

		expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
	});

	it("re-subscribes the flights channel on the new socket", () => {
		renderProvider();
		const first = FakeWebSocket.instances[0];
		act(() => first.onopen?.());
		expect(subscribedTo(first, "flights")).toBe(true);

		act(() => first.drop());
		act(() => {
			vi.advanceTimersByTime(30_000);
		});
		const next = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
		// Without this the assertion below re-reads the ORIGINAL socket, which
		// subscribed at mount, and passes while nothing has reconnected at all.
		expect(next).not.toBe(first);
		act(() => next.onopen?.());

		// The whole point: without this the app is subscribed client-side but the
		// server has no record of it, so flights never arrive again.
		expect(subscribedTo(next, "flights")).toBe(true);
	});

	it("backs off rather than reconnecting in a tight loop", () => {
		renderProvider();
		act(() => FakeWebSocket.instances[0].onopen?.());
		act(() => FakeWebSocket.instances[0].drop());

		// The streamer is down: every attempt fails the instant it is made. Step
		// through two minutes, failing each new socket as it appears.
		let seen = 1;
		for (let t = 0; t < 120; t++) {
			act(() => {
				vi.advanceTimersByTime(1_000);
			});
			while (seen < FakeWebSocket.instances.length) {
				const fresh = FakeWebSocket.instances[seen];
				seen += 1;
				act(() => fresh.drop());
			}
		}

		// Backoff reaching the 30s cap allows roughly 1+2+4+8+16+30+30+30 ≈ 8
		// attempts across two minutes. A fixed short retry would produce dozens,
		// and every client in the fleet does this at once when a pod rolls.
		expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
		expect(FakeWebSocket.instances.length).toBeLessThanOrEqual(12);
	});

	it("grows the delay exponentially and caps it", () => {
		// Zero jitter isolates the schedule itself.
		const noJitter = () => 0;
		const delays = [0, 1, 2, 3, 4, 5, 6, 10].map((n) => reconnectDelayMs(n, noJitter));

		expect(delays.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
		// Capped, not unbounded: attempt 10 must not be 1024 seconds.
		expect(delays.at(-1)).toBe(30_000);
	});

	it("jitters within a bounded window so clients do not return in lockstep", () => {
		// Full-jitter draws must stay inside [delay, 1.5*delay] — enough spread to
		// break up the herd, never so much that recovery stalls.
		expect(reconnectDelayMs(0, () => 0)).toBe(1_000);
		expect(reconnectDelayMs(0, () => 1)).toBe(1_500);
		expect(reconnectDelayMs(0, () => 0.5)).toBe(1_250);
	});

	it("stops reconnecting once the provider unmounts", () => {
		const { unmount } = renderProvider();
		const first = FakeWebSocket.instances[0];
		act(() => first.onopen?.());
		act(() => first.drop());

		unmount();
		const afterUnmount = FakeWebSocket.instances.length;
		act(() => {
			vi.advanceTimersByTime(60_000);
		});

		expect(FakeWebSocket.instances.length).toBe(afterUnmount);
	});
});
