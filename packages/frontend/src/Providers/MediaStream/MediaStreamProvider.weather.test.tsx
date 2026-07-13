import { encode } from "@msgpack/msgpack";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useContext, useEffect } from "react";
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
vi.mock("classicy", () => ({
	useClassicyDateTime: () => ({
		localDate: FIXED_LOCAL_DATE,
		dateTime: mockDateTime,
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

function WeatherConsumer({ appId = "test.app" }: { appId?: string }) {
	const { weatherObservations, subscribeWeather } = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeWeather(appId);
	}, [subscribeWeather, appId]);
	const stations = Object.keys(weatherObservations).sort();
	return (
		<ul>
			{stations.map((station) => (
				<li key={station} data-testid="station">
					{station}:{weatherObservations[station].temp_c}
				</li>
			))}
		</ul>
	);
}

// Captures the live context value into an external ref on every render, so
// the test can drive subscribe/unsubscribe directly via act() instead of
// relying on effect-cleanup ordering across an unmount.
function ContextCapture({
	captured,
}: {
	captured: { current: MediaStreamContextValue | null };
}) {
	const ctx = useContext(MediaStreamContext);
	captured.current = ctx;
	return null;
}

function ForecastConsumer({ zone }: { zone: string }) {
	const { weatherForecastByZone, subscribeWeather, requestWeatherForecast } =
		useContext(MediaStreamContext);
	useEffect(() => {
		subscribeWeather("test.app");
	}, [subscribeWeather]);
	useEffect(() => {
		requestWeatherForecast(zone);
	}, [requestWeatherForecast, zone]);
	const entry = weatherForecastByZone[zone];
	return (
		<div data-testid="forecast">
			{entry === undefined ? "pending" : entry === null ? "none" : entry.raw_text}
		</div>
	);
}

function lastWeatherForecastReq(ws: FakeWebSocket): { zone: string; id: number } {
	const req = ws.sent
		.map((s) => JSON.parse(s) as { type: string; zone: string; id: number })
		.filter((m) => m.type === "weather_forecast")
		.at(-1);
	if (!req) throw new Error("no weather_forecast request sent");
	return req;
}

describe("MediaStreamProvider weather channel", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		mockDateTime = NOW_ISO;
		vi.stubGlobal("WebSocket", FakeWebSocket);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("sends subscribe once for two apps and keeps the channel until both unsubscribe", () => {
		const captured: { current: MediaStreamContextValue | null } = { current: null };
		render(
			<MediaStreamProvider>
				<ContextCapture captured={captured} />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => {
			captured.current?.subscribeWeather("app.one");
			captured.current?.subscribeWeather("app.two");
		});
		const subscribeMsgs = ws.sent.filter(
			(m) => m === JSON.stringify({ type: "subscribe", channel: "weather" }),
		);
		expect(subscribeMsgs.length).toBe(1);

		act(() => captured.current?.unsubscribeWeather("app.one"));
		expect(
			ws.sent.some(
				(m) => m === JSON.stringify({ type: "unsubscribe", channel: "weather" }),
			),
		).toBe(false); // app.two still subscribed — channel stays live

		act(() => captured.current?.unsubscribeWeather("app.two"));
		const unsubscribeMsgs = ws.sent.filter(
			(m) => m === JSON.stringify({ type: "unsubscribe", channel: "weather" }),
		);
		expect(unsubscribeMsgs.length).toBe(1);
	});

	it("splits a weather frame into due (surfaced) and future (buffered) observations", () => {
		render(
			<MediaStreamProvider>
				<WeatherConsumer />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather",
					time: NOW_ISO,
					weather: [
						{
							id: 1,
							station_id: "KLGA",
							start_date: "2001-09-11T12:59:00.000Z", // due
							temp_c: 22.8,
						},
						{
							id: 2,
							station_id: "KJFK",
							start_date: "2001-09-11T13:05:00.000Z", // future -> buffered
							temp_c: 20.1,
						},
					],
				}),
			);
		});

		const shown = screen.getAllByTestId("station").map((el) => el.textContent);
		expect(shown).toEqual(["KLGA:22.8"]);
	});

	it("does not regress a station when a late stale-window frame carries an older start_date", () => {
		render(
			<MediaStreamProvider>
				<WeatherConsumer />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather",
					time: NOW_ISO,
					weather: [
						{
							id: 5,
							station_id: "KLGA",
							start_date: "2001-09-11T12:55:00.000Z",
							temp_c: 21.0,
						},
					],
				}),
			);
		});
		expect(
			screen.getAllByTestId("station").map((el) => el.textContent),
		).toEqual(["KLGA:21"]);

		// A late/reordered frame delivers a fresh id but an OLDER start_date for
		// the same station — id-dedup alone would wrongly let this win.
		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather",
					time: NOW_ISO,
					weather: [
						{
							id: 6,
							station_id: "KLGA",
							start_date: "2001-09-11T12:50:00.000Z",
							temp_c: 19.0,
						},
					],
				}),
			);
		});
		expect(
			screen.getAllByTestId("station").map((el) => el.textContent),
		).toEqual(["KLGA:21"]); // unchanged — the older reading was rejected
	});

	it("seek clears the reveal buffer but keeps per-station state until the snapshot replaces it", () => {
		const view = render(
			<MediaStreamProvider>
				<WeatherConsumer />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather",
					time: NOW_ISO,
					weather: [
						{
							id: 1,
							station_id: "KLGA",
							start_date: "2001-09-11T12:59:00.000Z",
							temp_c: 22.8,
						},
					],
				}),
			);
		});
		expect(
			screen.getAllByTestId("station").map((el) => el.textContent),
		).toEqual(["KLGA:22.8"]);

		// Manual seek: jump the clock far enough to cross SEEK_THRESHOLD_MS.
		mockDateTime = "2001-09-11T09:00:00.000Z";
		view.rerender(
			<MediaStreamProvider>
				<WeatherConsumer />
			</MediaStreamProvider>,
		);

		// Per-station state persists through the seek itself (not reset to {}).
		expect(
			screen.getAllByTestId("station").map((el) => el.textContent),
		).toEqual(["KLGA:22.8"]);

		expect(
			ws.sent.some(
				(m) =>
					JSON.parse(m).type === "seek" &&
					JSON.parse(m).time === "2001-09-11T09:00:00.000Z",
			),
		).toBe(true);

		// The post-seek snapshot arrives on a normal weather frame and replaces
		// the station's entry via the usual merge path.
		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather",
					time: "2001-09-11T09:00:00Z",
					weather: [
						{
							id: 9,
							station_id: "KLGA",
							start_date: "2001-09-11T08:55:00.000Z",
							temp_c: 18.4,
						},
					],
				}),
			);
		});
		expect(
			screen.getAllByTestId("station").map((el) => el.textContent),
		).toEqual(["KLGA:18.4"]);
	});

	it("drops a forecast reply whose echoed id does not match the current request", () => {
		render(
			<MediaStreamProvider>
				<ForecastConsumer zone="NYZ076" />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		// Generation numbers can't be hardcoded here: the consumer's mount-time
		// effect fires before the provider's socket-creation effect (children
		// mount before parents), so that request never reaches the wire but
		// still bumps the generation — see MediaStreamProvider.flights.test.tsx's
		// lastHistoryReq for the same gotcha. Only the wire-observed id matters.
		const req = lastWeatherForecastReq(ws);
		expect(req.zone).toBe("NYZ076");

		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather_forecast",
					id: req.id - 1, // stale id from a superseded request
					time: NOW_ISO,
					weather_forecasts: [
						{
							id: 1,
							wfo: "OKX",
							zone: "NYZ072,NYZ073,NYZ076",
							product_type: "ZFP",
							start_date: "2001-09-11T08:35:00Z",
							raw_text: "STALE",
						},
					],
				}),
			);
		});
		expect(screen.getByTestId("forecast").textContent).toBe("pending");
	});

	it("lands an explicit-empty forecast reply as confirmed-none (null), not pending", () => {
		render(
			<MediaStreamProvider>
				<ForecastConsumer zone="NYZ076" />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		const req = lastWeatherForecastReq(ws);

		expect(screen.getByTestId("forecast").textContent).toBe("pending");

		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather_forecast",
					id: req.id,
					time: NOW_ISO,
				}),
			);
		});
		expect(screen.getByTestId("forecast").textContent).toBe("none");
	});

	it("delivers a matching-id forecast reply", () => {
		render(
			<MediaStreamProvider>
				<ForecastConsumer zone="NYZ076" />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		const req = lastWeatherForecastReq(ws);

		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather_forecast",
					id: req.id,
					time: NOW_ISO,
					weather_forecasts: [
						{
							id: 512,
							wfo: "OKX",
							zone: "NYZ072,NYZ073,NYZ076",
							product_type: "ZFP",
							start_date: "2001-09-11T08:35:00Z",
							raw_text: "NEW YORK CITY ZONE FORECAST PRODUCT",
						},
					],
				}),
			);
		});
		expect(screen.getByTestId("forecast").textContent).toBe(
			"NEW YORK CITY ZONE FORECAST PRODUCT",
		);
	});

	it("seek clears forecast state and re-requests the last zone with a fresh id", () => {
		const view = render(
			<MediaStreamProvider>
				<ForecastConsumer zone="NYZ076" />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		const preSeekReq = lastWeatherForecastReq(ws);

		// Land a product for the pre-seek clock.
		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather_forecast",
					id: preSeekReq.id,
					time: NOW_ISO,
					weather_forecasts: [
						{
							id: 512,
							wfo: "OKX",
							zone: "NYZ072,NYZ073,NYZ076",
							product_type: "ZFP",
							start_date: "2001-09-11T08:35:00Z",
							raw_text: "SEPT 11 PRODUCT",
						},
					],
				}),
			);
		});
		expect(screen.getByTestId("forecast").textContent).toBe("SEPT 11 PRODUCT");

		// Manual seek two days back — the 9/11 product is now an anachronism.
		mockDateTime = "2001-09-09T13:00:00.000Z";
		view.rerender(
			<MediaStreamProvider>
				<ForecastConsumer zone="NYZ076" />
			</MediaStreamProvider>,
		);

		// State cleared back to pending, and a fresh request went out for the
		// same zone with a bumped id.
		expect(screen.getByTestId("forecast").textContent).toBe("pending");
		const postSeekReq = lastWeatherForecastReq(ws);
		expect(postSeekReq.zone).toBe("NYZ076");
		expect(postSeekReq.id).toBeGreaterThan(preSeekReq.id);

		// (b) A late reply still carrying the pre-seek id must be dropped.
		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather_forecast",
					id: preSeekReq.id,
					time: NOW_ISO,
					weather_forecasts: [
						{
							id: 513,
							wfo: "OKX",
							zone: "NYZ072,NYZ073,NYZ076",
							product_type: "ZFP",
							start_date: "2001-09-11T09:00:00Z",
							raw_text: "LATE PRE-SEEK PRODUCT",
						},
					],
				}),
			);
		});
		expect(screen.getByTestId("forecast").textContent).toBe("pending");

		// The post-seek reply (matching the new id) repopulates the zone.
		act(() => {
			ws.onmessage?.(
				frame({
					type: "weather_forecast",
					id: postSeekReq.id,
					time: "2001-09-09T13:00:00Z",
					weather_forecasts: [
						{
							id: 200,
							wfo: "OKX",
							zone: "NYZ072,NYZ073,NYZ076",
							product_type: "ZFP",
							start_date: "2001-09-09T08:35:00Z",
							raw_text: "SEPT 9 PRODUCT",
						},
					],
				}),
			);
		});
		expect(screen.getByTestId("forecast").textContent).toBe("SEPT 9 PRODUCT");
	});

	it("seek without a prior forecast request sends no weather_forecast message", () => {
		const view = render(
			<MediaStreamProvider>
				<WeatherConsumer />
			</MediaStreamProvider>,
		);
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		mockDateTime = "2001-09-09T13:00:00.000Z";
		view.rerender(
			<MediaStreamProvider>
				<WeatherConsumer />
			</MediaStreamProvider>,
		);

		expect(
			ws.sent.some((m) => JSON.parse(m).type === "seek"),
		).toBe(true);
		expect(
			ws.sent.some((m) => JSON.parse(m).type === "weather_forecast"),
		).toBe(false);
	});
});
