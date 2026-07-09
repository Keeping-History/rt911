import { encode } from "@msgpack/msgpack";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";

// Fixed virtual clock: 2001-09-11T13:00:00Z, no display-tz offset, so
// virtualUtcMs(localDate, 0) === 13:00 UTC exactly.
const NOW_ISO = "2001-09-11T13:00:00.000Z";
// Hoisted to a single stable Date instance: the provider's per-second tick
// effect depends on [localDate, tzOffset], and a fresh `new Date(...)` on
// every render (a new reference each call) would never satisfy Object.is
// dependency comparison, re-firing the effect (and its setState calls) every
// render — an infinite render loop that pegs the CPU without ever finishing.
const FIXED_LOCAL_DATE = new Date(NOW_ISO);
vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({
		localDate: FIXED_LOCAL_DATE,
		dateTime: NOW_ISO,
		tzOffset: 0,
	}),
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

function FlightsConsumer() {
	const { flightPositions, subscribeFlights } = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeFlights("test.app");
	}, [subscribeFlights]);
	return (
		<ul>
			{flightPositions.map((p) => (
				<li key={p.id} data-testid="flight">
					{p.flight}
				</li>
			))}
		</ul>
	);
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

describe("MediaStreamProvider flights channel", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("subscribes on first app, surfaces due positions, buffers future ones", () => {
		render(
			<MediaStreamProvider>
				<FlightsConsumer />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		expect(ws).toBeDefined();
		act(() => ws.onopen?.());

		expect(
			ws.sent.some(
				(m) => m === JSON.stringify({ type: "subscribe", channel: "flights" }),
			),
		).toBe(true);

		act(() => {
			ws.onmessage?.(
				frame({
					type: "flights",
					time: NOW_ISO,
					flights: [
						{
							id: 1,
							flight: "AA11",
							start_date: "2001-09-11T12:59:00.000Z", // due (≤ now)
							lat: 40.7,
							lon: -74.0,
							alt_ft: 29000,
						},
						{
							id: 2,
							flight: "UA175",
							start_date: "2001-09-11T13:03:00.000Z", // future → buffered
							lat: 40.6,
							lon: -74.1,
							alt_ft: 31000,
						},
					],
				}),
			);
		});

		const shown = screen.getAllByTestId("flight").map((el) => el.textContent);
		expect(shown).toEqual(["AA11"]);
	});
});

function HistoryConsumer({ minutes }: { minutes: 30 | 90 }) {
	const {
		flightsHistory,
		flightsHistoryDone,
		requestFlightsHistory,
		subscribeFlights,
	} = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeFlights("test.app");
	}, [subscribeFlights]);
	useEffect(() => {
		requestFlightsHistory(minutes);
	}, [requestFlightsHistory, minutes]);
	return (
		<div>
			<span data-testid="history-count">{flightsHistory.length}</span>
			<span data-testid="history-done">{String(flightsHistoryDone)}</span>
		</div>
	);
}

const histPos = (id: number, iso: string): object => ({
	id,
	flight: "AA11",
	start_date: iso,
	lat: 42,
	lon: -71,
	alt_ft: 30000,
});

// The id of the most recent flights_history request the provider actually sent.
// Generation numbers can't be hardcoded: child effects run before the provider's
// socket-creation effect, so the mount-time request never reaches the wire and
// the first delivered request already carries a later generation.
function lastHistoryReq(ws: FakeWebSocket): { minutes: number; id: number } {
	const req = ws.sent
		.map((s) => JSON.parse(s) as { type: string; minutes: number; id: number })
		.filter((m) => m.type === "flights_history")
		.at(-1);
	if (!req) throw new Error("no flights_history request sent");
	return req;
}

describe("MediaStreamProvider flights_history", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("requests history and accumulates chunks until done", () => {
		render(
			<MediaStreamProvider>
				<HistoryConsumer minutes={30} />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		const req = lastHistoryReq(ws);
		expect(req.minutes).toBe(30);

		act(() => {
			ws.onmessage?.(
				frame({
					type: "flights_history",
					id: req.id,
					flights: [histPos(1, "2001-09-11T12:31:00Z")],
				}),
			);
			ws.onmessage?.(
				frame({
					type: "flights_history",
					id: req.id,
					flights: [histPos(2, "2001-09-11T12:41:00Z")],
				}),
			);
		});
		expect(screen.getByTestId("history-count").textContent).toBe("2");
		expect(screen.getByTestId("history-done").textContent).toBe("false");

		act(() =>
			ws.onmessage?.(frame({ type: "flights_history", id: req.id, done: true })),
		);
		expect(screen.getByTestId("history-done").textContent).toBe("true");
	});

	it("discards chunks from a superseded request and re-requests on window change", () => {
		const view = render(
			<MediaStreamProvider>
				<HistoryConsumer minutes={30} />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		const req30 = lastHistoryReq(ws);

		act(() => {
			ws.onmessage?.(
				frame({
					type: "flights_history",
					id: req30.id,
					flights: [histPos(1, "2001-09-11T12:31:00Z")],
				}),
			);
		});
		expect(screen.getByTestId("history-count").textContent).toBe("1");

		// Window change → next generation; a chunk from the old request still in
		// flight must be ignored, and the accumulated state resets.
		view.rerender(
			<MediaStreamProvider>
				<HistoryConsumer minutes={90} />
			</MediaStreamProvider>,
		);
		const req90 = lastHistoryReq(ws);
		expect(req90.minutes).toBe(90);
		expect(req90.id).toBeGreaterThan(req30.id);
		expect(screen.getByTestId("history-count").textContent).toBe("0");

		act(() => {
			ws.onmessage?.(
				frame({
					type: "flights_history",
					id: req30.id,
					flights: [histPos(9, "2001-09-11T12:32:00Z")],
				}),
			);
		});
		expect(screen.getByTestId("history-count").textContent).toBe("0"); // stale, dropped

		act(() => {
			ws.onmessage?.(
				frame({
					type: "flights_history",
					id: req90.id,
					flights: [histPos(3, "2001-09-11T11:35:00Z")],
				}),
			);
		});
		expect(screen.getByTestId("history-count").textContent).toBe("1");
	});

	it("re-issues the active history request on reconnect with a fresh id", () => {
		render(
			<MediaStreamProvider>
				<HistoryConsumer minutes={30} />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		const before = ws.sent.filter(
			(s) => JSON.parse(s).type === "flights_history",
		).length;
		expect(before).toBeGreaterThan(0);
		act(() => ws.onopen?.()); // reconnect: onopen re-runs subscribe + history
		const reqs = ws.sent
			.map((s) => JSON.parse(s))
			.filter((m) => m.type === "flights_history");
		expect(reqs.length).toBe(before + 1);
		expect(reqs.at(-1)!.id).toBeGreaterThan(reqs[before - 1].id);
	});
});
