import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
	type WeatherObservation,
} from "../../Providers/MediaStream/MediaStreamContext";

// Mock the map (WebGL) — assert wiring, not rendering, same pattern as
// FlightTracker.test.tsx's FlightMap mock.
const mapProps: Array<Record<string, unknown>> = [];
vi.mock("./WeatherMap", () => ({
	WeatherMap: (props: Record<string, unknown>) => {
		mapProps.push(props);
		return <div data-testid="weathermap" />;
	},
}));

const windowProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
// Mutable virtual clock (true UTC dateTime string, as useClassicyDateTime
// returns it — TV.tsx:222 precedent). Defaults to 9/11 8:40 AM ET boot time.
const mockClock = vi.hoisted(() => ({ current: "2001-09-11T12:40:00.000Z" }));

vi.mock("classicy", () => ({
	ClassicyApp: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: (
		props: Record<string, unknown> & { children?: React.ReactNode },
	) => {
		windowProps.push(props);
		return <div>{props.children}</div>;
	},
	ClassicyControlGroup: ({
		label,
		children,
	}: {
		label?: string;
		children?: React.ReactNode;
	}) => (
		<div>
			<span>{label}</span>
			{children}
		</div>
	),
	ClassicyIcons: { applications: {} },
	registerClassicyIcons: <T,>(icons: T) => icons,
	quitMenuItemHelper: () => ({}),
	useClassicyDateTime: () => ({ dateTime: mockClock.current, paused: false }),
}));

import { Weather } from "./Weather";

const FAKE_RADAR_INDEX = {
	bounds: [
		[-126, 50],
		[-66, 50],
		[-66, 24],
		[-126, 24],
	],
	frames: [],
	missing: [],
	interval_seconds: 300,
	key_prefix: "weather/radar/",
	key_pattern: "n0r_{stamp}.png",
};

function fakeAlmanacFor(stationId: string) {
	return {
		station_id: stationId,
		ghcn_id: "USW00094789",
		cutoff: "2001-09-08",
		run_id: "abc123",
		days: {
			"09-09": {
				record_high_c: 30, record_high_year: 1983,
				record_low_c: 12, record_low_year: 1965,
				normal_high_c: 25.1, normal_low_c: 17.8,
				record_precip_mm: 40, record_precip_year: 1960,
			},
			"09-10": {
				record_high_c: null, record_high_year: null,
				record_low_c: null, record_low_year: null,
				normal_high_c: null, normal_low_c: null,
				record_precip_mm: null, record_precip_year: null,
			},
			"09-11": {
				record_high_c: 31, record_high_year: 1955,
				record_low_c: 11, record_low_year: 1990,
				normal_high_c: 24.7, normal_low_c: 17.3,
				record_precip_mm: 38, record_precip_year: 1961,
			},
			"09-12": {
				record_high_c: 29, record_high_year: 1998,
				record_low_c: 10, record_low_year: 2000,
				normal_high_c: 24.3, normal_low_c: 16.9,
				record_precip_mm: 35, record_precip_year: 1979,
			},
		},
	};
}

function stubFetch() {
	const fetchMock = vi.fn((url: string) => {
		if (url.includes("/weather/radar/index.json")) {
			return Promise.resolve({ ok: true, json: async () => FAKE_RADAR_INDEX } as Response);
		}
		const match = /almanac\/([A-Z0-9]+)\.json$/.exec(url);
		if (match) {
			return Promise.resolve({
				ok: true,
				json: async () => fakeAlmanacFor(match[1]),
			} as Response);
		}
		return Promise.resolve({ ok: false, status: 404 } as Response);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function makeCtxValue(
	overrides: Partial<MediaStreamContextValue>,
): MediaStreamContextValue {
	return {
		items: [],
		pagerItems: [],
		mp3Items: [],
		mp3History: [],
		newsItems: [],
		usenetItems: [],
		usenetBodies: {},
		usenetBodyErrors: {},
		requestUsenetBody: () => {},
		sources: { video: [], audio: [], pager: [], usenet: [] },
		connected: false,
		addItems: () => {},
		subscribeFormats: () => {},
		unsubscribeFormats: () => {},
		subscribePager: () => {},
		unsubscribePager: () => {},
		subscribeMp3: () => {},
		unsubscribeMp3: () => {},
		getUpcomingMp3Items: () => [],
		subscribeNews: () => {},
		unsubscribeNews: () => {},
		subscribeUsenet: () => {},
		unsubscribeUsenet: () => {},
		setUsenetGroups: () => {},
		requestUsenetOlder: () => {},
		flightPositions: [],
		subscribeFlights: () => {},
		unsubscribeFlights: () => {},
		flightsHistory: [],
		flightsHistoryDone: false,
		requestFlightsHistory: () => {},
		clearFlightsHistory: () => {},
		weatherObservations: {},
		weatherForecastByZone: {},
		subscribeWeather: () => {},
		unsubscribeWeather: () => {},
		requestWeatherForecast: () => {},
		...overrides,
	};
}

function renderWithContext(overrides: Partial<MediaStreamContextValue> = {}) {
	return render(
		<MediaStreamContext.Provider value={makeCtxValue(overrides)}>
			<Weather />
		</MediaStreamContext.Provider>,
	);
}

describe("Weather", () => {
	afterEach(() => {
		cleanup();
		mapProps.length = 0;
		windowProps.length = 0;
		mockClock.current = "2001-09-11T12:40:00.000Z";
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("renders the map and the conditions panel", async () => {
		stubFetch();
		renderWithContext();
		expect(screen.getByTestId("weathermap")).toBeTruthy();
		// Default selection is KJFK.
		await waitFor(() => expect(screen.getByText(/KENNEDY/i)).toBeTruthy());
	});

	it("subscribes on mount and unsubscribes on unmount", () => {
		stubFetch();
		const subscribeWeather = vi.fn();
		const unsubscribeWeather = vi.fn();
		const { unmount } = renderWithContext({ subscribeWeather, unsubscribeWeather });
		expect(subscribeWeather).toHaveBeenCalledWith("Weather.app");
		expect(unsubscribeWeather).not.toHaveBeenCalled();
		unmount();
		expect(unsubscribeWeather).toHaveBeenCalledWith("Weather.app");
	});

	it("requests the forecast once for the default station's zone", async () => {
		stubFetch();
		const requestWeatherForecast = vi.fn();
		renderWithContext({ requestWeatherForecast });
		await waitFor(() =>
			expect(requestWeatherForecast).toHaveBeenCalledWith("NYZ076"), // KJFK
		);
		expect(requestWeatherForecast).toHaveBeenCalledTimes(1);
	});

	it("selecting a new station fires exactly one forecast request for its zone", async () => {
		stubFetch();
		const requestWeatherForecast = vi.fn();
		renderWithContext({ requestWeatherForecast });
		await waitFor(() =>
			expect(requestWeatherForecast).toHaveBeenCalledWith("NYZ076"),
		);
		requestWeatherForecast.mockClear();

		const onSelectStation = mapProps.at(-1)!.onSelectStation as (id: string) => void;
		act(() => onSelectStation("KORD"));

		await waitFor(() =>
			expect(requestWeatherForecast).toHaveBeenCalledWith("ILZ013"), // KORD
		);
		expect(requestWeatherForecast).toHaveBeenCalledTimes(1);
	});

	it("a null-zone station skips the forecast request and shows the no-archive message", async () => {
		stubFetch();
		const requestWeatherForecast = vi.fn();
		renderWithContext({ requestWeatherForecast });
		await waitFor(() =>
			expect(requestWeatherForecast).toHaveBeenCalledWith("NYZ076"),
		);
		requestWeatherForecast.mockClear();

		const onSelectStation = mapProps.at(-1)!.onSelectStation as (id: string) => void;
		act(() => onSelectStation("KHSV")); // null nws_zone

		await waitFor(() =>
			expect(screen.getByText("No archived forecast for this station.")).toBeTruthy(),
		);
		expect(requestWeatherForecast).not.toHaveBeenCalled();
	});

	it("shows 'retrieving…' while a forecast reply is pending, then renders the text", async () => {
		stubFetch();
		const { rerender } = renderWithContext({ weatherForecastByZone: {} });
		await waitFor(() => expect(screen.getByText("retrieving…")).toBeTruthy());

		rerender(
			<MediaStreamContext.Provider
				value={makeCtxValue({
					weatherForecastByZone: {
						NYZ076: {
							id: 1,
							wfo: "OKX",
							zone: "NYZ076",
							product_type: "ZFP",
							start_date: "2001-09-11T08:35:00Z",
							raw_text: "NEW YORK CITY ZONE FORECAST",
						},
					},
				})}
			>
				<Weather />
			</MediaStreamContext.Provider>,
		);
		expect(screen.getByText("NEW YORK CITY ZONE FORECAST")).toBeTruthy();
	});

	it("shows the explicit-null 'no product' message", async () => {
		stubFetch();
		renderWithContext({ weatherForecastByZone: { NYZ076: null } });
		await waitFor(() =>
			expect(screen.getByText("No forecast product at this hour.")).toBeTruthy(),
		);
	});

	it("renders '—' for every absent numeric observation field", async () => {
		stubFetch();
		const obs: WeatherObservation = {
			id: 1,
			station_id: "KJFK",
			start_date: "2001-09-11T12:51:00Z",
			// every numeric field intentionally omitted
		};
		renderWithContext({ weatherObservations: { KJFK: obs } });
		await waitFor(() => expect(screen.getByText(/KENNEDY/i)).toBeTruthy());
		// temp, wind, visibility, pressure, dewpoint all render em-dash.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
	});

	it("renders real values (°F conversion, wind, visibility cap) when present", async () => {
		stubFetch();
		const obs: WeatherObservation = {
			id: 1,
			station_id: "KJFK",
			start_date: "2001-09-11T12:51:00Z",
			temp_c: 21.1,
			dewpoint_c: 15,
			wind_dir_deg: 270,
			wind_speed_kt: 10,
			gust_kt: 18,
			pressure_hpa: 1013,
			visibility_km: 20, // caps at 10 mi
		};
		renderWithContext({ weatherObservations: { KJFK: obs } });
		await waitFor(() => expect(screen.getByText(/70°F/)).toBeTruthy());
		expect(screen.getByText(/W 12 mph \(gusts 21 mph\)/)).toBeTruthy();
		expect(screen.getByText("10 mi")).toBeTruthy();
		expect(screen.getByText("29.91 inHg")).toBeTruthy();
		expect(screen.getByText("59°F")).toBeTruthy();
	});

	it("treats zero readings as real values, not absent ones (the 0-is-falsy trap)", async () => {
		stubFetch();
		const obs: WeatherObservation = {
			id: 1,
			station_id: "KJFK",
			start_date: "2001-09-11T12:51:00Z",
			temp_c: 0, // freezing, not missing → 32°F
			wind_dir_deg: 0, // due north, not missing
			wind_speed_kt: 0, // calm, not missing → "N 0 mph"
		};
		renderWithContext({ weatherObservations: { KJFK: obs } });
		await waitFor(() => expect(screen.getByText(/32°F/)).toBeTruthy());
		expect(screen.getByText("N 0 mph")).toBeTruthy();
		// Only the genuinely absent fields (sky line, visibility, pressure,
		// dewpoint) render the dash — temp and wind must not be among them.
		expect(screen.getAllByText("—").length).toBe(4);
	});

	it("shows the almanac block within the 09-09..09-12 window", async () => {
		stubFetch();
		mockClock.current = "2001-09-11T12:40:00.000Z";
		renderWithContext();
		await waitFor(() => expect(screen.getByText("Almanac")).toBeTruthy());
		await waitFor(() => expect(screen.getByText(/Record high/)).toBeTruthy());
	});

	it("hides the almanac block outside the 09-09..09-12 window", async () => {
		stubFetch();
		mockClock.current = "2001-09-13T12:40:00.000Z";
		renderWithContext();
		await waitFor(() => expect(screen.getByText(/KENNEDY/i)).toBeTruthy());
		expect(screen.queryByText("Almanac")).toBeNull();
	});

	it("registers app.png as the app icon and passes it to the window", () => {
		stubFetch();
		renderWithContext();
		expect(windowProps.length).toBeGreaterThan(0);
		for (const w of windowProps) {
			expect(String(w.icon)).toMatch(/app\.png/);
		}
	});
});
