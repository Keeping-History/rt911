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

function toFrame(bytes: Uint8Array): { data: ArrayBuffer } {
	return {
		data: bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	};
}

function frame(payload: object): { data: ArrayBuffer } {
	return toFrame(encode(payload));
}

/**
 * An `mp3_meta` frame whose `items` map has INTEGER keys, exactly as Go's
 * `map[int]model.ItemMeta` puts on the wire.
 *
 * Assembled by hand because @msgpack/msgpack's encoder has no way to emit a
 * non-string map key — it serialises a JS Map as an empty object. Encoding the
 * frame the convenient way (`{ items: { "5821": … } }`) would test a shape the
 * streamer never sends, and the whole question here is whether an id-keyed
 * lookup survives the wire's key type.
 */
function intKeyedMetaFrame(
	generation: string,
	items: Record<number, object>,
): { data: ArrayBuffer } {
	const entries = Object.entries(items);
	const parts: Uint8Array[] = [
		Uint8Array.of(0x83), // fixmap, 3 pairs: type, generation, items
		encode("type"),
		encode("mp3_meta"),
		encode("generation"),
		encode(generation),
		encode("items"),
		Uint8Array.of(0x80 | entries.length), // fixmap of the id → meta pairs
	];
	for (const [id, meta] of entries) {
		parts.push(encode(Number(id)), encode(meta));
	}
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return toFrame(out);
}

function setClock(iso: string, view: ReturnType<typeof render>) {
	mockDateTime = iso;
	mockLocalDate = new Date(iso);
	view.rerender(
		<MediaStreamProvider>
			<MetaConsumer />
		</MediaStreamProvider>,
	);
}

// Reads through the same id-keyed lookup a Radio Traffic card makes, including
// the id that has no metadata — 59 of 814 recordings carry no parties blob, so
// "absent" is the ordinary case, not the error case.
function MetaConsumer() {
	const { mp3Meta, mp3MetaGeneration, subscribeMp3 } = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeMp3("test.app");
	}, [subscribeMp3]);
	return (
		<>
			<div data-testid="subject">{mp3Meta[5821]?.subject ?? "none"}</div>
			<div data-testid="tags">{(mp3Meta[5821]?.tags ?? []).map((t) => t.tag).join(",")}</div>
			<div data-testid="missing">{String(mp3Meta[999]?.subject)}</div>
			<div data-testid="ids">{Object.keys(mp3Meta).join(",")}</div>
			<div data-testid="generation">{String(mp3MetaGeneration)}</div>
		</>
	);
}

const text = (id: string) => screen.getByTestId(id).textContent;

const META_5821 = {
	subject: "Boston Center coordinates with NEADS",
	tier: "primary",
	tags: [{ tag: "facility:zbw", namespace: "facility", value: "ZBW" }],
};

const CLIP = {
	id: 5821,
	title: "ATC",
	full_title: "ATC",
	source: "ATC",
	start_date: "2001-09-11T13:00:00.000Z",
	end_date: "2001-09-11T13:00:30.000Z",
	url: "u",
	format: "mp3",
	approved: 1,
	mute: 0,
	volume: 1,
	jump: 0,
	trim: 0,
};

function connect(): { view: ReturnType<typeof render>; ws: FakeWebSocket } {
	const view = render(
		<MediaStreamProvider>
			<MetaConsumer />
		</MediaStreamProvider>,
	);
	const ws = FakeWebSocket.instances[0];
	act(() => ws.onopen?.());
	return { view, ws };
}

describe("mp3Meta", () => {
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

	it("is empty before any frame arrives, and yields undefined for any id", () => {
		connect();
		expect(text("ids")).toBe("");
		expect(text("missing")).toBe("undefined");
	});

	it("populates keyed by item id from an mp3_meta frame", () => {
		const { ws } = connect();
		act(() => {
			ws.onmessage?.(intKeyedMetaFrame("gen-1", { 5821: META_5821 }));
		});

		expect(text("subject")).toBe("Boston Center coordinates with NEADS");
		expect(text("tags")).toBe("facility:zbw");
		expect(text("generation")).toBe("gen-1");
	});

	it("yields undefined for an id the frame carries no metadata for", () => {
		// Not every recording has a parties blob to derive from, so a card asking
		// for one that doesn't must render its plain title, not throw.
		const { ws } = connect();
		act(() => {
			ws.onmessage?.(intKeyedMetaFrame("gen-1", { 5821: META_5821 }));
		});

		expect(text("missing")).toBe("undefined");
	});

	// The frame is one-shot: the server sends it once per session and never
	// again, not on seek and not on resubscribe. If a seek dropped it the way it
	// drops every time-scoped buffer, the cards would lose their metadata for
	// the rest of the session with nothing left to restore it.
	it("survives a seek, which re-requests every time-scoped channel", () => {
		const { view, ws } = connect();
		act(() => {
			ws.onmessage?.(intKeyedMetaFrame("gen-1", { 5821: META_5821 }));
		});

		// Ten minutes, comfortably past SEEK_THRESHOLD_MS (90s).
		act(() => setClock("2001-09-11T13:10:00.000Z", view));
		expect(ws.sent.some((s) => JSON.parse(s).type === "seek")).toBe(true);

		act(() => {
			ws.onmessage?.(frame({ type: "mp3_history", items: [] }));
			ws.onmessage?.(frame({ type: "mp3", time: "2001-09-11T13:10:00.000Z", items: [] }));
		});

		expect(text("subject")).toBe("Boston Center coordinates with NEADS");
		expect(text("generation")).toBe("gen-1");
	});

	// Metadata has no time dimension, so the per-second reveal tick — which
	// promotes items whose start_date has arrived and prunes expired ones — must
	// not touch it. An entry for a clip that has already finished is still the
	// only thing that can describe that clip on the Previous lane.
	it("survives the reveal tick that prunes an expired clip", () => {
		const { view, ws } = connect();
		act(() => {
			ws.onmessage?.(intKeyedMetaFrame("gen-1", { 5821: META_5821 }));
			ws.onmessage?.(frame({ type: "mp3", time: NOW_ISO, items: [CLIP] }));
		});

		// Well past the clip's end_date: the tick effect runs the retention pass.
		act(() => setClock("2001-09-11T13:01:00.000Z", view));

		expect(text("ids")).toBe("5821");
		expect(text("subject")).toBe("Boston Center coordinates with NEADS");
	});

	it("replaces wholesale when a reconnect delivers a fresh frame", () => {
		// A new socket is a new session, so the server sends its one-shot again.
		const { ws } = connect();
		act(() => {
			ws.onmessage?.(intKeyedMetaFrame("gen-1", { 5821: META_5821 }));
		});
		act(() => {
			ws.onmessage?.(
				intKeyedMetaFrame("gen-2", { 42: { subject: "NEADS to Otis", tags: [] } }),
			);
		});

		expect(text("ids")).toBe("42");
		expect(text("subject")).toBe("none");
		expect(text("generation")).toBe("gen-2");
	});

	it("tolerates a frame with no items", () => {
		const { ws } = connect();
		act(() => {
			ws.onmessage?.(frame({ type: "mp3_meta", generation: "gen-1" }));
		});

		expect(text("ids")).toBe("");
		expect(text("generation")).toBe("gen-1");
	});
});
