import { encode } from "@msgpack/msgpack";
import { act, render, screen } from "@testing-library/react";
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
