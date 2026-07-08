import { render, screen } from "@testing-library/react";
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
}));

import { FlightTracker } from "./FlightTracker";

// Real MediaStreamContext.Provider (as MediaStreamProvider.flights.test.tsx
// does for its consumer) rather than mocking `react`'s useContext — this repo
// has no precedent for mocking core React, and the real Provider exercises
// the same context plumbing every other app relies on.
const subscribeFlights = vi.fn();
const unsubscribeFlights = vi.fn();

function renderWithContext(overrides: Partial<MediaStreamContextValue>) {
	const ctxValue: MediaStreamContextValue = {
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
	return render(
		<MediaStreamContext.Provider value={ctxValue}>
			<FlightTracker />
		</MediaStreamContext.Provider>,
	);
}

describe("FlightTracker", () => {
	afterEach(() => {
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
});
