import { act, cleanup, render } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext, type MediaStreamContextValue } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";

// Fixed virtual clock: no display-tz offset needed for this suite — it only
// exercises requestNewsBody's de-dup logic, not clock-gated reveal/prune.
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

// Captures the live context value into an external ref on every render, so
// the test can drive requestNewsBody directly via act() — see
// MediaStreamProvider.weather.test.tsx for the same pattern.
function ContextCapture({
	captured,
}: {
	captured: { current: MediaStreamContextValue | null };
}) {
	const ctx = useContext(MediaStreamContext);
	captured.current = ctx;
	return null;
}

describe("MediaStreamProvider requestNewsBody de-dup", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("sends only one news_body request for the same id while it is in flight", () => {
		const captured: { current: MediaStreamContextValue | null } = { current: null };
		render(
			<MediaStreamProvider>
				<ContextCapture captured={captured} />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => {
			captured.current?.requestNewsBody(42);
			captured.current?.requestNewsBody(42);
		});

		const newsBodyReqs = ws.sent
			.map((s) => JSON.parse(s) as { type: string; id?: number })
			.filter((m) => m.type === "news_body" && m.id === 42);
		expect(newsBodyReqs.length).toBe(1);
	});
});
