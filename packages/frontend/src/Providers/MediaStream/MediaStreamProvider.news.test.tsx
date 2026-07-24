import { encode } from "@msgpack/msgpack";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";

// Virtual clock: 2001-09-11T13:00:00Z, tzOffset 0, so virtualUtcMs === 13:00 UTC.
const NOW_ISO = "2001-09-11T13:00:00.000Z";
let mockDateTime = NOW_ISO;
// `let`, not `const`: tests advance the clock by reassigning BOTH of these and
// then calling view.rerender(). The instance must stay stable across renders
// that don't advance the clock, or the tick effect re-fires forever.
let mockLocalDate = new Date(NOW_ISO);

vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({
		localDate: mockLocalDate,
		dateTime: mockDateTime,
		tzOffset: 0,
	}),
	// Forced-clock enforcement effects (MediaStreamProvider) read/dispatch
	// through these; this suite doesn't exercise that behavior, so a
	// no-op/empty-store stub is enough to satisfy the import.
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

/** Advance (or rewind) the mocked virtual clock and re-render to fire the effects. */
function setClock(iso: string, view: ReturnType<typeof render>) {
	mockDateTime = iso;
	mockLocalDate = new Date(iso);
	view.rerender(
		<MediaStreamProvider>
			<NewsConsumer />
		</MediaStreamProvider>,
	);
}

// An article from 9/9 — two days older than INSTANT_RETENTION_MS (10 min) would
// ever allow. It is the whole point of the feature that this survives.
const OLD_ARTICLE = {
	id: 4001,
	title: "Sharon rules out talks",
	start_date: "2001-09-09T14:12:00.000Z",
	end_date: "2001-09-09T14:12:00.000Z",
	format: "news",
	source: "ap",
};

function NewsConsumer({ appId = "test.app" }: { appId?: string }) {
	const { newsItems, subscribeNews } = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeNews(appId);
	}, [subscribeNews, appId]);
	return <div data-testid="ids">{newsItems.map((i) => i.id).join(",")}</div>;
}

describe("news backlog retention", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		mockDateTime = NOW_ISO;
		mockLocalDate = new Date(NOW_ISO);
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});

	// This repo has no RTL auto-cleanup — every test file must do this itself.
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("keeps an article from 9/9 that instant retention would have pruned", () => {
		const view = render(
			<MediaStreamProvider>
				<NewsConsumer />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		act(() => {
			ws.onmessage?.(frame({ type: "news", time: NOW_ISO, items: [OLD_ARTICLE] }));
		});

		expect(screen.getByTestId("ids").textContent).toBe("4001");

		// Advance one second: the prune pass runs on this tick, and it is exactly
		// where keepMediaItem used to discard the article.
		act(() => setClock("2001-09-11T13:00:01.000Z", view));

		expect(screen.getByTestId("ids").textContent).toBe("4001");
	});

	it("clears the backlog on a backward seek so future articles do not linger", () => {
		const view = render(
			<MediaStreamProvider>
				<NewsConsumer />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		act(() => {
			ws.onmessage?.(frame({ type: "news", time: NOW_ISO, items: [OLD_ARTICLE] }));
		});
		expect(screen.getByTestId("ids").textContent).toBe("4001");

		// Rewind to before the article's start: it is now future-dated. This is the
		// case keepMediaItem's leading-edge guard used to cover. The jump is two
		// days, far past BACKWARD_SEEK_THRESHOLD_MS (2_000 ms, seekDetection.ts:30).
		act(() => setClock("2001-09-09T12:00:00.000Z", view));

		expect(screen.getByTestId("ids").textContent).toBe("");
	});
});
