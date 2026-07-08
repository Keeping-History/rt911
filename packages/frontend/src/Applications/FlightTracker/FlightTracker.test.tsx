import { act, cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../Providers/MediaStream/MediaStreamContext";

// Mock the map (WebGL) — assert wiring, not rendering.
const mapProps: Array<Record<string, unknown>> = [];
vi.mock("./FlightMap", () => ({
	FlightMap: (props: Record<string, unknown>) => {
		mapProps.push(props);
		return <div data-testid="flightmap" />;
	},
}));

// classicy primitives → plain elements; useAppManager returns a state the
// isRunning selector reads as "open".
vi.mock("classicy", () => ({
	ClassicyApp: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	ClassicyWindow: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	ClassicyIcons: { controlPanels: { location: { app: "icon.png" } } },
	quitMenuItemHelper: () => ({}),
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: {
				Manager: {
					Applications: {
						apps: { "FlightTracker.app": { open: true, windows: [] } },
					},
					Appearance: {
						activeTheme: { measurements: { window: { paddingSize: 0 } } },
					},
				},
			},
		}),
	useAppManagerDispatch: () => vi.fn(),
	useClassicyDateTime: () => ({
		localDate: new Date("2001-09-11T13:00:00.000Z"),
		tzOffset: 0,
		paused: false,
	}),
}));

import { FlightTracker } from "./FlightTracker";

// Real MediaStreamContext.Provider (as MediaStreamProvider.flights.test.tsx
// does for its consumer) rather than mocking `react`'s useContext — this repo
// has no precedent for mocking core React, and the real Provider exercises
// the same context plumbing every other app relies on.
const subscribeFlights = vi.fn();
const unsubscribeFlights = vi.fn();

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
		subscribeFlights,
		unsubscribeFlights,
		...overrides,
	};
}

function renderWithContext(overrides: Partial<MediaStreamContextValue>) {
	return render(
		<MediaStreamContext.Provider value={makeCtxValue(overrides)}>
			<FlightTracker />
		</MediaStreamContext.Provider>,
	);
}

describe("FlightTracker", () => {
	afterEach(() => {
		cleanup();
		mapProps.length = 0;
		vi.clearAllMocks();
	});

	it("subscribes to the flights channel while running and passes positions to the map", () => {
		renderWithContext({
			flightPositions: [
				{
					id: 1,
					flight: "AA11",
					start_date: "2001-09-11T13:00:00Z",
					lat: 40,
					lon: -74,
					alt_ft: 30000,
				},
			],
			connected: true,
		});
		expect(subscribeFlights).toHaveBeenCalledWith("FlightTracker.app");
		expect(screen.getByTestId("flightmap")).toBeTruthy();
		const last = mapProps[mapProps.length - 1];
		expect((last.positions as unknown[]).length).toBe(1);
	});

	it("clears the selection when the selected flight leaves the airborne set (e.g. after a seek)", () => {
		// useFlightTrack fires a real fetch once a flight is selected; stub it out
		// so the test only exercises the selection-clearing behavior under test.
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
		);

		const aa11 = {
			id: 1,
			flight: "AA11",
			start_date: "2001-09-11T13:00:00Z",
			lat: 40,
			lon: -74,
			alt_ft: 30000,
		};

		const { rerender } = renderWithContext({
			flightPositions: [aa11],
			connected: true,
		});

		// Simulate the map reporting a click on AA11, as FlightTracker wires
		// FlightMap's onSelectFlight to do.
		const onSelectFlight = mapProps[mapProps.length - 1].onSelectFlight as (
			flight: string,
		) => void;
		act(() => {
			onSelectFlight("AA11");
		});
		expect(screen.getByText("AA11")).toBeTruthy();

		// Seek: the streamed set no longer contains AA11 (it's landed/not yet
		// airborne at the new clock position). The spec requires the stale
		// selection to be cleared, not left pointing at a flight that's gone.
		rerender(
			<MediaStreamContext.Provider
				value={makeCtxValue({ flightPositions: [], connected: true })}
			>
				<FlightTracker />
			</MediaStreamContext.Provider>,
		);

		expect(screen.queryByText("AA11")).toBeNull();
		expect(screen.getByText("Select a flight to view its track.")).toBeTruthy();

		vi.unstubAllGlobals();
	});

	it("passes the virtual clock to the map", () => {
		renderWithContext({
			flightPositions: [
				{
					id: 1,
					flight: "AA11",
					start_date: "2001-09-11T13:00:00Z",
					lat: 40,
					lon: -74,
					alt_ft: 30000,
				},
			],
			connected: true,
		});
		const last = mapProps[mapProps.length - 1];
		expect(typeof last.nowMs).toBe("number");
		expect(last.playing).toBe(true); // paused:false → playing
	});
});
