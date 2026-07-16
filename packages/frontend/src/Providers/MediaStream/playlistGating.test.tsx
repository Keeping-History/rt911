// Playlist availability gating at the MediaStreamProvider choke point:
// blocked items never surface, and the same injected data appears once the
// predicate allows it (windows = pure function of the predicate).
import { encode } from "@msgpack/msgpack";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";
import { PlaylistContext, type PlaylistContextValue } from "../Playlist/PlaylistContext";
import type { PlaylistApp } from "../Playlist/playlistTypes";

const NOW_ISO = "2001-09-11T13:00:00.000Z";
// Single stable Date instance — a fresh reference each render would re-fire
// the provider's per-second tick effect forever (see flights test note).
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

function frame(payload: object): { data: ArrayBuffer } {
	const bytes = encode(payload);
	return {
		data: bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	};
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

function SourcesConsumer() {
	const { sources } = useContext(MediaStreamContext);
	return <span data-testid="video-sources">{sources.video.join(",")}</span>;
}

const blockValue = (blockApp: PlaylistApp, blockId: string): PlaylistContextValue => ({
	active: true,
	title: "T",
	isItemAvailable: (app, itemId) => !(app === blockApp && itemId === blockId),
});

const FLIGHTS_FRAME = {
	type: "flights",
	time: NOW_ISO,
	flights: [
		{ id: 1, flight: "AA11", start_date: "2001-09-11T12:59:00.000Z", lat: 40.7, lon: -74.0, alt_ft: 29000 },
		{ id: 2, flight: "UA175", start_date: "2001-09-11T12:59:30.000Z", lat: 40.6, lon: -74.1, alt_ft: 31000 },
	],
};

describe("MediaStreamProvider playlist gating", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("hides a blocked flight and shows it under an allow-all predicate", () => {
		const { rerender } = render(
			<PlaylistContext.Provider value={blockValue("flights", "UA175")}>
				<MediaStreamProvider>
					<FlightsConsumer />
				</MediaStreamProvider>
			</PlaylistContext.Provider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		act(() => {
			ws.onmessage?.(frame(FLIGHTS_FRAME));
		});
		expect(screen.getAllByTestId("flight").map((el) => el.textContent)).toEqual(["AA11"]);

		// Window "opens": swap to an allow-all predicate and resend the frame.
		rerender(
			<PlaylistContext.Provider value={blockValue("flights", "nobody")}>
				<MediaStreamProvider>
					<FlightsConsumer />
				</MediaStreamProvider>
			</PlaylistContext.Provider>,
		);
		act(() => {
			ws.onmessage?.(frame(FLIGHTS_FRAME));
		});
		expect(screen.getAllByTestId("flight").map((el) => el.textContent)).toEqual([
			"AA11",
			"UA175",
		]);
	});

	it("filters blocked TV sources out of the sources list", () => {
		render(
			<PlaylistContext.Provider value={blockValue("tv", "CNN")}>
				<MediaStreamProvider>
					<SourcesConsumer />
				</MediaStreamProvider>
			</PlaylistContext.Provider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		act(() => {
			ws.onmessage?.(
				frame({
					type: "sources",
					sources: { video: ["ABC", "CNN"], audio: [], pager: [], usenet: [] },
				}),
			);
		});
		expect(screen.getByTestId("video-sources").textContent).toBe("ABC");
	});
});
