import { encode } from "@msgpack/msgpack";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";

// Virtual clock: 2001-09-11T13:00:00Z, tzOffset 0, so virtualUtcMs === 13:00 UTC.
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

function frame(payload: object): { data: ArrayBuffer } {
	const bytes = encode(payload);
	return {
		data: bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	};
}

function setClock(iso: string, view: ReturnType<typeof render>) {
	mockDateTime = iso;
	mockLocalDate = new Date(iso);
	view.rerender(
		<MediaStreamProvider>
			<SeekConsumer />
		</MediaStreamProvider>,
	);
}

function SeekConsumer() {
	const { seekInFlight, subscribeMp3 } = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeMp3("test.app");
	}, [subscribeMp3]);
	return <div data-testid="seeking">{String(seekInFlight)}</div>;
}

const seeking = () => screen.getByTestId("seeking").textContent;

const CLIP = {
	id: 7,
	title: "ATC",
	full_title: "ATC",
	source: "ATC",
	start_date: "2001-09-11T13:04:00.000Z",
	end_date: "2001-09-11T13:04:30.000Z",
	url: "u",
	format: "mp3",
	approved: 1,
	mute: 0,
	volume: 1,
	jump: 0,
	trim: 0,
};

/** Render, open the socket, and return the fake socket. */
function connect(): {
	view: ReturnType<typeof render>;
	ws: FakeWebSocket;
} {
	const view = render(
		<MediaStreamProvider>
			<SeekConsumer />
		</MediaStreamProvider>,
	);
	const ws = FakeWebSocket.instances[0];
	act(() => ws.onopen?.());
	return { view, ws };
}

// The seek-in-flight flag is what the Radio Traffic card's SEEKING badge reads
// (cardStatus.badgeFor). Before this, nothing tracked a seek after dispatching
// it: seekDetection cleared the buffers, sent {type:"seek"} and forgot.
describe("seekInFlight", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		mockDateTime = NOW_ISO;
		mockLocalDate = new Date(NOW_ISO);
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("is false on a settled connection", () => {
		connect();
		// The on-connect window request is not a user seek: nothing on screen is
		// out of date, so a card must not paint SEEKING on first render.
		expect(seeking()).toBe("false");
	});

	it("raises while a forward clock jump is in flight", () => {
		const { view, ws } = connect();
		// Ten minutes, comfortably past SEEK_THRESHOLD_MS (90s).
		act(() => setClock("2001-09-11T13:10:00.000Z", view));

		expect(ws.sent.some((s) => JSON.parse(s).type === "seek")).toBe(true);
		expect(seeking()).toBe("true");
	});

	it("raises on a backward jump too", () => {
		const { view } = connect();
		act(() => setClock("2001-09-11T12:50:00.000Z", view));
		expect(seeking()).toBe("true");
	});

	it("stays down for an ordinary minute tick", () => {
		// The clock auto-advances ~60s per tick, under SEEK_THRESHOLD_MS. If those
		// raised the flag the badge would read SEEKING once a minute, forever.
		const { view } = connect();
		act(() => setClock("2001-09-11T13:01:00.000Z", view));
		expect(seeking()).toBe("false");
	});

	it("clears when the fresh mp3 window arrives", () => {
		const { view, ws } = connect();
		act(() => setClock("2001-09-11T13:10:00.000Z", view));
		expect(seeking()).toBe("true");

		act(() => {
			ws.onmessage?.(
				frame({
					type: "mp3",
					time: "2001-09-11T13:10:00.000Z",
					items: [{ ...CLIP, start_date: "2001-09-11T13:10:00.000Z" }],
				}),
			);
		});

		expect(seeking()).toBe("false");
	});

	it("clears on the history snapshot when the new window holds no mp3 items", () => {
		// Seeking into a quiet stretch sends an mp3_history frame (always, even
		// empty) but may send no mp3 frame at all. Waiting only on `mp3` would
		// pin the badge at SEEKING until the next clip hours later.
		const { view, ws } = connect();
		act(() => setClock("2001-09-11T13:10:00.000Z", view));
		expect(seeking()).toBe("true");

		act(() => {
			ws.onmessage?.(frame({ type: "mp3_history", items: [] }));
		});

		expect(seeking()).toBe("false");
	});

	it("clears on an mp3 frame that carries no items", () => {
		// Same trap one level down: the mp3 handler early-returns on an empty
		// item list, so the clear must happen before that guard.
		const { view, ws } = connect();
		act(() => setClock("2001-09-11T13:10:00.000Z", view));
		expect(seeking()).toBe("true");

		act(() => {
			ws.onmessage?.(frame({ type: "mp3", time: NOW_ISO, items: [] }));
		});

		expect(seeking()).toBe("false");
	});

	it("re-raises on a second seek after the first resolved", () => {
		const { view, ws } = connect();
		act(() => setClock("2001-09-11T13:10:00.000Z", view));
		act(() => {
			ws.onmessage?.(frame({ type: "mp3_history", items: [] }));
		});
		expect(seeking()).toBe("false");

		act(() => setClock("2001-09-11T13:40:00.000Z", view));
		expect(seeking()).toBe("true");
	});
});
