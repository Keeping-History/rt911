import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const dispatchMock = vi.hoisted(() => vi.fn());
const windowProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mockAppData = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

// classicy primitives → plain elements; useAppManager returns a state the
// isRunning selector reads as "open". ClassicyWindow records its props so
// tests can drive appMenu items; mockAppData.current feeds persisted app data.
vi.mock("classicy", () => ({
	ClassicyApp: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
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
	ClassicyControlLabel: ({ label }: { label?: string }) => <span>{label}</span>,
	ClassicyButton: ({
		children,
		onClickFunc,
	}: {
		children?: React.ReactNode;
		onClickFunc?: () => void;
	}) => <button onClick={onClickFunc}>{children}</button>,
	ClassicyCheckbox: ({
		id,
		label,
		checked,
		onClickFunc,
	}: {
		id: string;
		label?: string;
		checked?: boolean;
		onClickFunc?: (checked: boolean) => void;
	}) => (
		<label>
			<input
				type="checkbox"
				data-testid={id}
				checked={!!checked}
				onChange={(e) => onClickFunc?.(e.target.checked)}
			/>
			{label}
		</label>
	),
	// The mock picker "picks" blue (0x0000ff) on click.
	ClassicyColorPicker: ({
		id,
		labelTitle,
		onChangeFunc,
	}: {
		id: string;
		labelTitle?: string;
		onChangeFunc?: (color: number) => void;
	}) => (
		<button data-testid={id} onClick={() => onChangeFunc?.(0x0000ff)}>
			{labelTitle}
		</button>
	),
	MAC_OS_8_CRAYONS: [],
	ClassicyIcons: { controlPanels: { location: { app: "icon.png" } } },
	quitMenuItemHelper: () => ({}),
	registerAppEventHandler: () => {},
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: {
				Manager: {
					Applications: {
						apps: {
							"FlightTracker.app": {
								open: true,
								windows: [],
								data: mockAppData.current,
							},
						},
					},
					Appearance: {
						activeTheme: { measurements: { window: { paddingSize: 0 } } },
					},
				},
			},
		}),
	useAppManagerDispatch: () => dispatchMock,
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

type MenuItem = { id?: string; title?: string; onClickFunc?: () => void };

// FlightTracker passes appMenu to its ClassicyWindows; the window mock records
// props, so tests find and "click" menu items from the latest recorded menus.
function menuItem(
	menuTitle: string,
	pred: (title: string) => boolean,
): MenuItem | undefined {
	for (let i = windowProps.length - 1; i >= 0; i--) {
		const menus = windowProps[i].appMenu as
			| Array<{ title?: string; menuChildren?: MenuItem[] }>
			| undefined;
		const item = menus
			?.find((m) => m.title === menuTitle)
			?.menuChildren?.find((i2) => pred(i2.title ?? ""));
		if (item) return item;
	}
	return undefined;
}

describe("FlightTracker", () => {
	afterEach(() => {
		cleanup();
		mapProps.length = 0;
		windowProps.length = 0;
		mockAppData.current = {};
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

	it("View ▸ Dark Map toggles darkMap in one dispatch, preserving pin colors", () => {
		renderWithContext({});
		const item = menuItem("View", (t) => t.includes("Dark Map"))!;
		expect(item.title).toBe("Dark Map"); // off by default → no ✓ prefix
		act(() => item.onClickFunc?.());
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { darkMap: true, pinColor: 0x3a3a3a, notablePinColor: 0xc0202a, radarSweep: true },
		});
	});

	it("reads persisted settings: ✓ menu prefix and int→hex conversion for the map", () => {
		mockAppData.current = {
			mapSettings: { darkMap: true, pinColor: 0x0000ff, notablePinColor: 0x00ff00 },
		};
		renderWithContext({});
		const last = mapProps[mapProps.length - 1];
		expect(last.darkMap).toBe(true);
		expect(last.pinColor).toBe("#0000ff");
		expect(last.notablePinColor).toBe("#00ff00");
		expect(menuItem("View", (t) => t.includes("Dark Map"))!.title).toBe("✓ Dark Map");
	});

	it("commits Settings edits on Save as a single dispatch", () => {
		renderWithContext({});
		act(() => menuItem("File", (t) => t.startsWith("Settings"))!.onClickFunc?.());
		fireEvent.click(screen.getByTestId("flight_settings_darkmap"));
		fireEvent.click(screen.getByTestId("flight_settings_pin_color")); // mock → 0x0000ff
		fireEvent.click(screen.getByTestId("flight_settings_notable_pin_color")); // mock → 0x0000ff
		fireEvent.click(screen.getByText("Save"));
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { darkMap: true, pinColor: 0x0000ff, notablePinColor: 0x0000ff, radarSweep: true },
		});
	});

	it("View ▸ Radar Sweep shows ✓ by default and toggles radarSweep off in one dispatch", () => {
		renderWithContext({});
		const item = menuItem("View", (t) => t.includes("Radar Sweep"))!;
		expect(item.title).toBe("✓ Radar Sweep"); // default on
		act(() => item.onClickFunc?.());
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { darkMap: false, pinColor: 0x3a3a3a, notablePinColor: 0xc0202a, radarSweep: false },
		});
	});

	it("passes radarSweep to the map and commits the Settings checkbox on Save", () => {
		renderWithContext({});
		expect(mapProps[mapProps.length - 1].radarSweep).toBe(true);
		act(() => menuItem("File", (t) => t.startsWith("Settings"))!.onClickFunc?.());
		fireEvent.click(screen.getByTestId("flight_settings_radar")); // on → off
		fireEvent.click(screen.getByText("Save"));
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { darkMap: false, pinColor: 0x3a3a3a, notablePinColor: 0xc0202a, radarSweep: false },
		});
	});

	it("discards Settings edits on Cancel", () => {
		renderWithContext({});
		act(() => menuItem("File", (t) => t.startsWith("Settings"))!.onClickFunc?.());
		fireEvent.click(screen.getByTestId("flight_settings_darkmap"));
		fireEvent.click(screen.getByText("Cancel"));
		const settingsDispatches = dispatchMock.mock.calls.filter(
			([a]) =>
				(a as { type?: string })?.type === "ClassicyAppFlightTrackerSetMapSettings",
		);
		expect(settingsDispatches).toHaveLength(0);
	});
});
