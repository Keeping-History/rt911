import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../Providers/MediaStream/MediaStreamContext";
import { DEFAULT_FLIGHT_MAP_SETTINGS } from "./flightMapSettings";

// Mock the map (WebGL) — assert wiring, not rendering.
const mapProps: Array<Record<string, unknown>> = [];
vi.mock("./FlightMap", () => ({
	FlightMap: (props: Record<string, unknown>) => {
		mapProps.push(props);
		return <div data-testid="flightmap" />;
	},
}));

// One airport POI, matching the shape useMapPois resolves to (see mapPois.ts).
// Master-on/nothing-disabled is the default FlightPoiSettings, so this single
// POI should reach FlightMap unfiltered on a default render.
const AIRPORT_POI = {
	id: 1, name: "Atlanta", layer: "Major Airports", category: "airport",
	detailTitle: "Airport Details", lat: 33.6, lon: -84.4,
	iata: "ATL", icao: "KATL", city: "Atlanta", region: "GA", details: null,
};
vi.mock("./useMapPois", () => ({
	useMapPois: () => [AIRPORT_POI],
	mapPoisUrl: () => "",
	resetMapPoisCache: () => {},
}));

const dispatchMock = vi.hoisted(() => vi.fn());
const windowProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mockAppData = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const mockRouteIndex = vi.hoisted(
	() => ({ current: new Map<string, unknown>() }),
);
// Mutable virtual clock (true UTC; tzOffset 0 so localDate === UTC instant).
// Defaults to 13:00 UTC on 9/11 — before the 13:26 FAA ground stop.
const mockClock = vi.hoisted(() => ({ current: "2001-09-11T13:00:00.000Z" }));

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
	// Tooltip wrapper (MapControls wraps every control in one) → passthrough.
	ClassicyBalloonHelp: ({ children }: { children?: React.ReactNode }) => (
		<>{children}</>
	),
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
	ClassicyPopUpMenu: ({
		id,
		options,
		selected,
		onChangeFunc,
	}: {
		id: string;
		options: Array<{ value: string; label: string }>;
		selected?: string;
		onChangeFunc?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
	}) => (
		<select data-testid={id} value={selected} onChange={(e) => onChangeFunc?.(e)}>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	),
	// Superset mock: the trail-length settings slider only uses value/onChangeFunc;
	// the loop scrub slider additionally uses min/max/onCommitFunc.
	ClassicySlider: ({
		id,
		value,
		min,
		max,
		onChangeFunc,
		onCommitFunc,
	}: {
		id: string;
		value?: number;
		min?: number;
		max?: number;
		onChangeFunc?: (e: React.ChangeEvent<HTMLInputElement>) => void;
		onCommitFunc?: (v: number) => void;
	}) => (
		<input
			type="range"
			data-testid={id}
			value={value}
			min={min}
			max={max}
			onChange={(e) => onChangeFunc?.(e)}
			onMouseUp={(e) => onCommitFunc?.(Number((e.target as HTMLInputElement).value))}
		/>
	),
	// Mirrors the real component's DOM shape (input id = option id, a <label
	// htmlFor> pointing at it) so getByLabelText resolves the same way it
	// would against the real ClassicyRadioInput.
	ClassicyRadioInput: ({
		name,
		label,
		inputs,
		onClickFunc,
	}: {
		name: string;
		label?: string;
		inputs: Array<{ id: string; label?: string; checked?: boolean }>;
		onClickFunc?: (id: string) => void;
	}) => (
		<div>
			<span>{label}</span>
			{inputs.map((inp) => (
				<div key={inp.id}>
					<input
						id={inp.id}
						type="radio"
						name={name}
						value={inp.id}
						defaultChecked={inp.checked}
						onChange={() => onClickFunc?.(inp.id)}
					/>
					<label htmlFor={inp.id}>{inp.label}</label>
				</div>
			))}
		</div>
	),
	MAC_OS_8_CRAYONS: [],
	ClassicyIcons: {
		controlPanels: { location: { app: "icon.png" } },
		applications: {},
	},
	registerClassicyIcons: <T,>(icons: T) => icons,
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
		localDate: new Date(mockClock.current),
		tzOffset: 0,
		paused: false,
	}),
}));

// The route index has its own fetch/cache tests (useRouteIndex.test.ts);
// here it's a controllable map so component tests never touch fetch.
vi.mock("./useRouteIndex", () => ({
	useRouteIndex: () => mockRouteIndex.current,
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
		alertItems: [],
		subscribeAlerts: () => {},
		unsubscribeAlerts: () => {},
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
		flightsHistory: [],
		flightsHistoryDone: false,
		flightsSeed: [],
		requestFlightsHistory: vi.fn(),
		clearFlightsHistory: vi.fn(),
		weatherObservations: {},
		weatherForecastByZone: {},
		subscribeWeather: vi.fn(),
		unsubscribeWeather: vi.fn(),
		requestWeatherForecast: vi.fn(),
		clockForced: false,
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
	// Depth-first search: menu items may live in nested submenus (e.g. the
	// View menu's "Map Style" group), so a flat children scan is not enough.
	const findIn = (items: MenuItem[] | undefined): MenuItem | undefined => {
		for (const item of items ?? []) {
			if (pred(item.title ?? "")) return item;
			const nested = findIn(
				(item as { menuChildren?: MenuItem[] }).menuChildren,
			);
			if (nested) return nested;
		}
		return undefined;
	};
	for (let i = windowProps.length - 1; i >= 0; i--) {
		const menus = windowProps[i].appMenu as
			| Array<{ title?: string; menuChildren?: MenuItem[] }>
			| undefined;
		const item = findIn(menus?.find((m) => m.title === menuTitle)?.menuChildren);
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
		mockClock.current = "2001-09-11T13:00:00.000Z";
		mockRouteIndex.current = new Map();
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

	it("registers app.png as the app icon and passes it to every window", () => {
		render(<FlightTracker />);
		expect(windowProps.length).toBeGreaterThan(0);
		for (const w of windowProps) {
			expect(String(w.icon)).toMatch(/app\.png/);
		}
	});

	it("keeps toolbar, status bar, and detail prompt mounted after layout restructure (#310)", () => {
		renderWithContext({});
		// Toolbar Filter button, status-bar aircraft count, and the empty detail
		// prompt must all coexist — proving mainColumn + filterPanel both mounted.
		// (The ClassicyButton mock in this file drops aria-label, so the
		// toolbar button's accessible name is its visible text — see the
		// "Filter…" queries used by the filter-panel tests below.)
		expect(screen.getByText("Filter…")).toBeTruthy();
		expect(screen.getByText(/aircraft aloft/i)).toBeTruthy();
		expect(screen.getByText(/select a flight/i)).toBeTruthy();
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

	it("View menu style items check the active style and dispatch a single mapStyle change", () => {
		renderWithContext({});
		expect(menuItem("View", (t) => t.includes("Classic Map"))!.title).toBe(
			"✓ Classic Map",
		); // default → checked
		expect(menuItem("View", (t) => t.includes("Radar"))!.title).toBe(
			"Radar",
		);
		const satellite = menuItem("View", (t) => t.includes("Satellite"))!;
		expect(satellite.title).toBe("Satellite");
		act(() => satellite.onClickFunc?.());
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { ...DEFAULT_FLIGHT_MAP_SETTINGS, mapStyle: "satellite" },
		});
	});

	it("View ▸ Dark Map toggles darkMap in one dispatch, preserving pin colors", () => {
		renderWithContext({});
		const item = menuItem("View", (t) => t.includes("Dark Map"))!;
		expect(item.title).toBe("Dark Map"); // off by default → no ✓ prefix
		act(() => item.onClickFunc?.());
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { ...DEFAULT_FLIGHT_MAP_SETTINGS, darkMap: true },
		});
	});

	it("dark map picks the dark pin colors; light map picks the light ones", () => {
		mockAppData.current = {
			mapSettings: {
				darkMap: true,
				pinColorLight: 0x111111, pinColorDark: 0x0000ff,
				notablePinColorLight: 0x222222, notablePinColorDark: 0x00ff00,
			},
		};
		renderWithContext({});
		const last = mapProps[mapProps.length - 1];
		expect(last.darkMap).toBe(true);
		// darkMap:true → the map gets the *dark* pair, not the light one.
		expect(last.pinColor).toBe("#0000ff");
		expect(last.notablePinColor).toBe("#00ff00");
		expect(menuItem("View", (t) => t.includes("Dark Map"))!.title).toBe("✓ Dark Map");
	});

	it("radar style picks the dark pin colors even with darkMap off", () => {
		mockAppData.current = {
			mapSettings: { mapStyle: "radar", darkMap: false },
		};
		renderWithContext({});
		const last = mapProps[mapProps.length - 1];
		// radar is always dark-toned regardless of the darkMap flag.
		expect(last.mapStyle).toBe("radar");
		expect(last.pinColor).toBe("#ffd700");
		expect(last.notablePinColor).toBe("#ff4d4d");
	});

	it("light map picks the light pin colors", () => {
		mockAppData.current = {
			mapSettings: {
				darkMap: false,
				pinColorLight: 0x111111, pinColorDark: 0x0000ff,
				notablePinColorLight: 0x222222, notablePinColorDark: 0x00ff00,
			},
		};
		renderWithContext({});
		const last = mapProps[mapProps.length - 1];
		expect(last.pinColor).toBe("#111111");
		expect(last.notablePinColor).toBe("#222222");
	});

	it("commits Settings edits on Save as a single dispatch", () => {
		renderWithContext({});
		act(() => menuItem("Edit", (t) => t.startsWith("Settings"))!.onClickFunc?.());
		fireEvent.click(screen.getByTestId("flight_settings_darkmap"));
		fireEvent.click(screen.getByTestId("flight_settings_pin_color_light")); // mock → 0x0000ff
		fireEvent.click(screen.getByTestId("flight_settings_pin_color_dark")); // mock → 0x0000ff
		fireEvent.click(screen.getByTestId("flight_settings_notable_pin_color_light")); // mock → 0x0000ff
		fireEvent.click(screen.getByTestId("flight_settings_notable_pin_color_dark")); // mock → 0x0000ff
		fireEvent.click(screen.getByText("Save"));
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: {
				...DEFAULT_FLIGHT_MAP_SETTINGS,
				darkMap: true,
				pinColorLight: 0x0000ff,
				pinColorDark: 0x0000ff,
				notablePinColorLight: 0x0000ff,
				notablePinColorDark: 0x0000ff,
			},
		});
	});

	it("Settings window map-style radio round-trips through Save", () => {
		renderWithContext({});
		act(() => menuItem("Edit", (t) => t.startsWith("Settings"))!.onClickFunc?.());
		fireEvent.click(screen.getByLabelText("Radar"));
		fireEvent.click(screen.getByText("Save"));
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { ...DEFAULT_FLIGHT_MAP_SETTINGS, mapStyle: "radar" },
		});
	});

	it("View ▸ Radar Sweep shows ✓ by default and toggles radarSweep off in one dispatch", () => {
		renderWithContext({});
		const item = menuItem("View", (t) => t.includes("Radar Sweep"))!;
		expect(item.title).toBe("✓ Radar Sweep"); // default on
		act(() => item.onClickFunc?.());
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { ...DEFAULT_FLIGHT_MAP_SETTINGS, radarSweep: false },
		});
	});

	it("passes radarSweep to the map and commits the Settings checkbox on Save", () => {
		renderWithContext({});
		expect(mapProps[mapProps.length - 1].radarSweep).toBe(true);
		act(() => menuItem("Edit", (t) => t.startsWith("Settings"))!.onClickFunc?.());
		fireEvent.click(screen.getByTestId("flight_settings_radar")); // on → off
		fireEvent.click(screen.getByText("Save"));
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { ...DEFAULT_FLIGHT_MAP_SETTINGS, radarSweep: false },
		});
	});

	it("commits the trail-length slider on Save", () => {
		renderWithContext({});
		act(() => menuItem("Edit", (t) => t.startsWith("Settings"))!.onClickFunc?.());
		fireEvent.change(screen.getByTestId("flight_settings_trail_multiplier"), {
			target: { value: "3.5" },
		});
		fireEvent.click(screen.getByText("Save"));
		expect(dispatchMock).toHaveBeenCalledWith({
			type: "ClassicyAppFlightTrackerSetMapSettings",
			mapSettings: { ...DEFAULT_FLIGHT_MAP_SETTINGS, trailMultiplier: 3.5 },
		});
	});

	it("discards Settings edits on Cancel", () => {
		renderWithContext({});
		act(() => menuItem("Edit", (t) => t.startsWith("Settings"))!.onClickFunc?.());
		fireEvent.click(screen.getByTestId("flight_settings_darkmap"));
		fireEvent.click(screen.getByText("Cancel"));
		const settingsDispatches = dispatchMock.mock.calls.filter(
			([a]) =>
				(a as { type?: string })?.type === "ClassicyAppFlightTrackerSetMapSettings",
		);
		expect(settingsDispatches).toHaveLength(0);
	});

	describe("loop mode", () => {
		it("is on by default: strip present, status reads Live (Loop), history requested", () => {
			const requestFlightsHistory = vi.fn();
			renderWithContext({ connected: true, requestFlightsHistory });
			expect(screen.getByTestId("flight_loop_scrub")).toBeTruthy();
			expect(screen.getByText("Live (Loop)")).toBeTruthy();
			expect(requestFlightsHistory).toHaveBeenCalledWith(30);
			expect(menuItem("View", (t) => t.includes("Loop Playback"))!.title).toBe(
				"✓ Loop Playback",
			);
		});

		it("View ▸ Loop Playback persists the enabled flag flipped off", () => {
			renderWithContext({ connected: true });
			act(() => menuItem("View", (t) => t.includes("Loop Playback"))!.onClickFunc?.());
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetLoopSettings",
				loopSettings: { enabled: false, windowMinutes: 30, speed: 10 },
			});
		});

		it("reads a persisted disabled flag: strip hidden, status Live, history cleared", () => {
			const clearFlightsHistory = vi.fn();
			mockAppData.current = { loopSettings: { enabled: false } };
			renderWithContext({ connected: true, clearFlightsHistory });
			expect(screen.queryByTestId("flight_loop_scrub")).toBeNull();
			expect(screen.getByText("Live")).toBeTruthy();
			expect(clearFlightsHistory).toHaveBeenCalled();
			expect(menuItem("View", (t) => t.includes("Loop Playback"))!.title).toBe(
				"Loop Playback",
			);
		});

		it("the window popup persists windowMinutes", () => {
			renderWithContext({ connected: true });
			fireEvent.change(screen.getByTestId("flight_loop_window"), {
				target: { value: "90" },
			});
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetLoopSettings",
				loopSettings: { enabled: true, windowMinutes: 90, speed: 10 },
			});
		});

		it("reads a persisted 90-minute window: requests history and sizes the window with 90", () => {
			const requestFlightsHistory = vi.fn();
			mockAppData.current = { loopSettings: { windowMinutes: 90 } };
			renderWithContext({ connected: true, requestFlightsHistory });
			expect(requestFlightsHistory).toHaveBeenCalledWith(90);
			expect(mapProps[mapProps.length - 1].loopWindowMs).toBe(90 * 60_000);
		});

		it("the speed popup persists the loop speed", () => {
			renderWithContext({ connected: true });
			fireEvent.change(screen.getByTestId("flight_loop_speed"), {
				target: { value: "100" },
			});
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetLoopSettings",
				loopSettings: { enabled: true, windowMinutes: 30, speed: 100 },
			});
		});

		it("seeds the loop clock speed from persisted settings", () => {
			mockAppData.current = { loopSettings: { speed: 500 } };
			renderWithContext({ connected: true });
			const last = mapProps[mapProps.length - 1];
			expect((last.loopClock as { speed: number }).speed).toBe(500);
		});

		it("the play/pause button freezes the loop clock and back", () => {
			renderWithContext({ connected: true });
			expect((mapProps.at(-1)!.loopClock as { paused: boolean }).paused).toBe(false);
			act(() => fireEvent.click(screen.getByText("⏸")));
			expect((mapProps.at(-1)!.loopClock as { paused: boolean }).paused).toBe(true);
			act(() => fireEvent.click(screen.getByText("▶")));
			expect((mapProps.at(-1)!.loopClock as { paused: boolean }).paused).toBe(false);
		});

		it("passes loop props through to FlightMap", () => {
			renderWithContext({ connected: true });
			const last = mapProps[mapProps.length - 1];
			expect(last.loopEnabled).toBe(true);
			expect(last.loopWindowMs).toBe(30 * 60_000);
			expect(last.replayBuffer).toBeInstanceOf(Map);
		});
	});

	describe("ground stop alert", () => {
		it("shows no alert before the order (13:00 UTC default clock)", () => {
			renderWithContext({ connected: true });
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("turns the status bar red with a centered alert while the stop is in effect", () => {
			mockClock.current = "2001-09-11T14:00:00.000Z";
			renderWithContext({ connected: true });
			const alert = screen.getByRole("alert");
			expect(alert.textContent).toBe("FAA GROUND STOP IN EFFECT");
			// The whole status bar (the nearest div — cells are spans) goes red
			// per issue #186, not just the alert text.
			expect(alert.closest("div")?.className).toContain("statusBarRed");
		});

		it("stays red overnight on September 12", () => {
			mockClock.current = "2001-09-12T06:00:00.000Z";
			renderWithContext({ connected: true });
			expect(screen.getByRole("alert").textContent).toBe(
				"FAA GROUND STOP IN EFFECT",
			);
		});

		it("shows a non-red lifted notice after airspace reopens on September 13", () => {
			mockClock.current = "2001-09-13T15:30:00.000Z";
			renderWithContext({ connected: true });
			const alert = screen.getByRole("alert");
			expect(alert.textContent).toBe("FAA ground stop lifted — airspace reopened");
			expect(alert.closest("div")?.className).not.toContain("statusBarRed");
		});

		it("drops the lifted notice an hour after reopening", () => {
			mockClock.current = "2001-09-13T16:00:00.000Z";
			renderWithContext({ connected: true });
			expect(screen.queryByRole("alert")).toBeNull();
		});
	});

	describe("flight filter (issue #188)", () => {
		const aa11 = {
			id: 1, flight: "AA11", carrier: "AA",
			start_date: "2001-09-11T13:00:00Z", lat: 40, lon: -74, alt_ft: 30000,
		};
		const ua175 = {
			id: 2, flight: "UA175", carrier: "UA",
			start_date: "2001-09-11T13:00:00Z", lat: 41, lon: -73, alt_ft: 31000,
		};

		it("the toolbar Filter button opens the filter window with five dropdowns and Clear", () => {
			renderWithContext({ flightPositions: [aa11, ua175], connected: true });
			fireEvent.click(screen.getByText("Filter…"));
			expect(windowProps.some((w) => w.id === "flight-filter")).toBe(true);
			for (const id of [
				"flight_filter_flight", "flight_filter_tail", "flight_filter_carrier",
				"flight_filter_origin", "flight_filter_dest",
			]) {
				expect(screen.getByTestId(id)).toBeTruthy();
			}
			expect(screen.getByText("Clear")).toBeTruthy();
		});

		it("Filter ▸ Filter Flights… opens the filter window", () => {
			renderWithContext({ connected: true });
			act(() => menuItem("Filter", (t) => t.startsWith("Filter Flights"))!.onClickFunc?.());
			expect(screen.getByTestId("flight_filter_carrier")).toBeTruthy();
		});

		it("changing a dropdown dispatches the merged filter immediately (live apply)", () => {
			renderWithContext({ flightPositions: [aa11, ua175], connected: true });
			fireEvent.click(screen.getByText("Filter…"));
			fireEvent.change(screen.getByTestId("flight_filter_carrier"), {
				target: { value: "AA" },
			});
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetFilterSettings",
				filterSettings: { flight: "", tail: "", carrier: "AA", origin: "", dest: "", flights: [] },
			});
		});

		it("a persisted carrier filter hides non-matching flights and shows the filtered count", () => {
			mockAppData.current = { filterSettings: { carrier: "AA" } };
			renderWithContext({ flightPositions: [aa11, ua175], connected: true });
			const last = mapProps[mapProps.length - 1];
			expect((last.positions as { flight: string }[]).map((p) => p.flight)).toEqual(["AA11"]);
			expect(last.visibleFlights).toEqual(new Set(["AA11"]));
			expect(screen.getByText("1 of 2 aircraft aloft · filtered")).toBeTruthy();
			expect(screen.getByText("Filter (on)…")).toBeTruthy();
		});

		it("origin filtering joins positions to the route index; missing rows are hidden", () => {
			mockRouteIndex.current = new Map([
				["AA11|2001-09-11", { tail_number: "N334AA", origin: "BOS", scheduled_dest: "LAX" }],
				// UA175 has no row → fails the origin criterion.
			]);
			mockAppData.current = { filterSettings: { origin: "BOS" } };
			renderWithContext({ flightPositions: [aa11, ua175], connected: true });
			const last = mapProps[mapProps.length - 1];
			expect((last.positions as { flight: string }[]).map((p) => p.flight)).toEqual(["AA11"]);
			expect(screen.getByText("1 of 2 aircraft aloft · filtered")).toBeTruthy();
		});

		it("an index-backed filter with an empty index hides everything (graceful degradation)", () => {
			mockAppData.current = { filterSettings: { origin: "BOS" } };
			renderWithContext({ flightPositions: [aa11, ua175], connected: true });
			expect((mapProps[mapProps.length - 1].positions as unknown[]).length).toBe(0);
			expect(screen.getByText("0 of 2 aircraft aloft · filtered")).toBeTruthy();
		});

		it("no filter → no visibleFlights set, unfiltered count, plain button label", () => {
			renderWithContext({ flightPositions: [aa11, ua175], connected: true });
			expect(mapProps[mapProps.length - 1].visibleFlights).toBeNull();
			expect(screen.getByText("2 aircraft aloft")).toBeTruthy();
			expect(screen.getByText("Filter…")).toBeTruthy();
		});

		it("a manual camera flatten un-persists the 3D toggle (issue #223)", () => {
			mockAppData.current = { mapSettings: { threeD: true } };
			renderWithContext({ connected: true });
			const onPitchedChange = mapProps[mapProps.length - 1].onPitchedChange as (p: boolean) => void;
			// Right-dragging the z-axis flat while 3D is on syncs the toggle off…
			act(() => onPitchedChange(false));
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetMapSettings",
				mapSettings: expect.objectContaining({ threeD: false }),
			});
			// …but re-pitching (only reachable via the toggle itself) dispatches nothing.
			dispatchMock.mockClear();
			act(() => onPitchedChange(true));
			expect(dispatchMock).not.toHaveBeenCalled();
		});

		it("area select fills the detail dropdown; Save as Filter persists the list (issue #225)", () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })),
			);
			renderWithContext({ flightPositions: [aa11, ua175], connected: true });
			const onAreaSelect = mapProps[mapProps.length - 1].onAreaSelect as (f: string[]) => void;
			act(() => onAreaSelect(["AA11", "UA175"]));
			// The selection dropdown lists both, active first.
			const dd = screen.getByTestId("flight_detail_selection") as HTMLSelectElement;
			expect(dd.value).toBe("AA11");
			// Switching the dropdown switches the detail selection (header span).
			fireEvent.change(dd, { target: { value: "UA175" } });
			expect(
				screen.getAllByText("UA175").some((el) => el.tagName === "SPAN"),
			).toBe(true);
			// Save as Filter persists the explicit flight list.
			fireEvent.click(screen.getByText("Save as Filter"));
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetFilterSettings",
				filterSettings: {
					flight: "", tail: "", carrier: "", origin: "", dest: "",
					flights: ["AA11", "UA175"],
				},
			});
			// The tool disarms after a selection.
			expect(mapProps[mapProps.length - 1].selectMode).toBe("off");
		});

		it("a persisted flight-list filter hides everything else", () => {
			mockAppData.current = { filterSettings: { flights: ["UA175"] } };
			renderWithContext({ flightPositions: [aa11, ua175], connected: true });
			const last = mapProps[mapProps.length - 1];
			expect((last.positions as { flight: string }[]).map((p) => p.flight)).toEqual(["UA175"]);
			expect(screen.getByText("1 of 2 aircraft aloft · filtered")).toBeTruthy();
			// The Filter window shows the removable saved-selection row.
			fireEvent.click(screen.getByText("Filter (on)…"));
			expect(screen.getByText("Selected flights (1)")).toBeTruthy();
			fireEvent.click(screen.getByText("Remove"));
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetFilterSettings",
				filterSettings: { flight: "", tail: "", carrier: "", origin: "", dest: "", flights: [] },
			});
		});

		it("Clear resets the filter in one dispatch", () => {
			mockAppData.current = { filterSettings: { carrier: "AA", origin: "BOS" } };
			renderWithContext({ flightPositions: [aa11], connected: true });
			fireEvent.click(screen.getByText("Filter (on)…"));
			fireEvent.click(screen.getByText("Clear"));
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetFilterSettings",
				filterSettings: { flight: "", tail: "", carrier: "", origin: "", dest: "", flights: [] },
			});
		});

		it("deselects the selected flight when the filter hides it", () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
			);
			const { rerender } = renderWithContext({
				flightPositions: [aa11, ua175], connected: true,
			});
			const onSelectFlight = mapProps[mapProps.length - 1].onSelectFlight as (
				flight: string,
			) => void;
			act(() => onSelectFlight("AA11"));
			expect(screen.getByText("AA11")).toBeTruthy();

			// A UA-only filter arrives (e.g. set in the filter window): AA11 is
			// now hidden, so the stale selection must clear.
			mockAppData.current = { filterSettings: { carrier: "UA" } };
			rerender(
				<MediaStreamContext.Provider
					value={makeCtxValue({ flightPositions: [aa11, ua175], connected: true })}
				>
					<FlightTracker />
				</MediaStreamContext.Provider>,
			);
			expect(screen.queryByText("AA11")).toBeNull();
			expect(screen.getByText("Select a flight to view its track.")).toBeTruthy();
			vi.unstubAllGlobals();
		});

		it("keeps a stale selected value as a synthesized dropdown option", () => {
			// Persisted carrier UA, but only AA flights are airborne — the UA
			// option must still exist so the select shows the real filter state.
			mockAppData.current = { filterSettings: { carrier: "UA" } };
			renderWithContext({ flightPositions: [aa11], connected: true });
			fireEvent.click(screen.getByText("Filter (on)…"));
			const select = screen.getByTestId("flight_filter_carrier") as HTMLSelectElement;
			expect([...select.options].map((o) => o.value)).toContain("UA");
			expect(select.value).toBe("UA");
		});
	});

	describe("camera follow (tracked flights)", () => {
		const aa11 = {
			id: 1, flight: "AA11", carrier: "AA",
			start_date: "2001-09-11T13:00:00Z", lat: 40, lon: -74, alt_ft: 30000,
		};
		const dl404 = {
			id: 2, flight: "DL404", carrier: "DL",
			start_date: "2001-09-11T13:00:00Z", lat: 41, lon: -73, alt_ft: 31000,
		};
		const stubFetch = () =>
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
			);

		it("arms the follow lock onto a selected tracked flight", () => {
			stubFetch();
			renderWithContext({ flightPositions: [aa11], connected: true });
			expect(mapProps.at(-1)!.followFlight).toBeNull(); // idle until armed
			act(() => (mapProps.at(-1)!.onSelectFlight as (f: string) => void)("AA11"));
			fireEvent.click(screen.getByTestId("flight_camera_follow"));
			expect(mapProps.at(-1)!.followFlight).toBe("AA11");
			// The (icon-only) toggle reflects the armed state via its checked flag.
			expect((screen.getByTestId("flight_camera_follow") as HTMLInputElement).checked).toBe(true);
			vi.unstubAllGlobals();
		});

		it("passes the persisted camera mode and dispatches a dropdown change", () => {
			mockAppData.current = { mapSettings: { cameraMode: "highlight" } };
			renderWithContext({ connected: true });
			expect(mapProps.at(-1)!.cameraMode).toBe("highlight");
			fireEvent.change(screen.getByTestId("flight_camera_mode"), {
				target: { value: "cockpit" },
			});
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetMapSettings",
				mapSettings: { ...DEFAULT_FLIGHT_MAP_SETTINGS, cameraMode: "cockpit" },
			});
		});

		it("never follows an untracked flight even if the toggle is forced", () => {
			stubFetch();
			renderWithContext({ flightPositions: [dl404], connected: true });
			act(() => (mapProps.at(-1)!.onSelectFlight as (f: string) => void)("DL404"));
			// A regular flight isn't one of the five tracked flights: arming stays inert.
			act(() => fireEvent.click(screen.getByTestId("flight_camera_follow")));
			expect(mapProps.at(-1)!.followFlight).toBeNull();
			vi.unstubAllGlobals();
		});
	});

	describe("POI wiring (Task 8)", () => {
		it("passes the enabled POIs to FlightMap by default (master on, nothing disabled)", () => {
			renderWithContext({});
			expect((mapProps.at(-1)!.pois as unknown[]).length).toBe(1);
		});

		it("selecting a POI shows Airport Details, clears flight selection, and reaches FlightMap as selectedPoiId", () => {
			const aa11 = {
				id: 1, flight: "AA11", carrier: "AA",
				start_date: "2001-09-11T13:00:00Z", lat: 40, lon: -74, alt_ft: 30000,
			};
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
			);
			renderWithContext({ flightPositions: [aa11], connected: true });

			// First select a flight, so we can prove the POI selection clears it.
			const onSelectFlight = mapProps.at(-1)!.onSelectFlight as (flight: string) => void;
			act(() => onSelectFlight("AA11"));
			expect(screen.getByText("AA11")).toBeTruthy();

			const onSelectPoi = mapProps.at(-1)!.onSelectPoi as (poi: typeof AIRPORT_POI) => void;
			act(() => onSelectPoi(AIRPORT_POI));

			expect(screen.getByText("Airport Details")).toBeTruthy();
			expect(screen.queryByText("AA11")).toBeNull();
			expect(mapProps.at(-1)!.selectedPoiId).toBe(1);

			vi.unstubAllGlobals();
		});

		it("selecting a flight clears any POI selection", () => {
			const aa11 = {
				id: 1, flight: "AA11", carrier: "AA",
				start_date: "2001-09-11T13:00:00Z", lat: 40, lon: -74, alt_ft: 30000,
			};
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
			);
			renderWithContext({ flightPositions: [aa11], connected: true });

			const onSelectPoi = mapProps.at(-1)!.onSelectPoi as (poi: typeof AIRPORT_POI) => void;
			act(() => onSelectPoi(AIRPORT_POI));
			expect(screen.getByText("Airport Details")).toBeTruthy();
			expect(mapProps.at(-1)!.selectedPoiId).toBe(1);

			const onSelectFlight = mapProps.at(-1)!.onSelectFlight as (flight: string) => void;
			act(() => onSelectFlight("AA11"));
			expect(screen.getByText("AA11")).toBeTruthy();
			expect(screen.queryByText("Airport Details")).toBeNull();
			expect(mapProps.at(-1)!.selectedPoiId).toBeNull();

			vi.unstubAllGlobals();
		});

		it("applying a remote focus command clears any POI selection", () => {
			const aa11 = {
				id: 1, flight: "AA11", carrier: "AA",
				start_date: "2001-09-11T13:00:00Z", lat: 40, lon: -74, alt_ft: 30000,
			};
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
			);
			const { rerender } = renderWithContext({
				flightPositions: [aa11], connected: true,
			});

			// Select the airport POI first, as a student browsing the map would.
			const onSelectPoi = mapProps.at(-1)!.onSelectPoi as (poi: typeof AIRPORT_POI) => void;
			act(() => onSelectPoi(AIRPORT_POI));
			expect(screen.getByText("Airport Details")).toBeTruthy();
			expect(mapProps.at(-1)!.selectedPoiId).toBe(1);

			// A teacher pushes a remote focus command for AA11 (playlist-driven,
			// via classicyFlightRemoteEventHandler in flightTrackerCommands.ts).
			mockAppData.current = {
				command: { seq: 1, kind: "focus", callsign: "AA11" },
			};
			rerender(
				<MediaStreamContext.Provider
					value={makeCtxValue({ flightPositions: [aa11], connected: true })}
				>
					<FlightTracker />
				</MediaStreamContext.Provider>,
			);

			expect(screen.queryByText("Airport Details")).toBeNull();
			expect(screen.getByText("AA11")).toBeTruthy();
			expect(mapProps.at(-1)!.selectedPoiId).toBeNull();

			vi.unstubAllGlobals();
		});

		it("View ▸ Layers… opens the Layers window with FlightLayersPanel's controls", () => {
			renderWithContext({});
			const item = menuItem("View", (t) => t.startsWith("Layers"));
			expect(item).toBeTruthy();
			act(() => item!.onClickFunc?.());
			expect(windowProps.some((w) => w.id === "flight-layers")).toBe(true);
			// FlightLayersPanel renders the master toggle + each distinct layer.
			expect(screen.getByText("Show POI layers")).toBeTruthy();
			expect(screen.getByText("Major Airports")).toBeTruthy();
		});

		it("toggling a layer off in the Layers window dispatches the POI-settings slice (separate from mapSettings)", () => {
			renderWithContext({});
			act(() => menuItem("View", (t) => t.startsWith("Layers"))!.onClickFunc?.());
			fireEvent.click(screen.getByLabelText("Major Airports"));
			expect(dispatchMock).toHaveBeenCalledWith({
				type: "ClassicyAppFlightTrackerSetPoiSettings",
				poiSettings: { enabled: true, disabledLayers: ["Major Airports"], unclusteredLayers: [] },
			});
		});

		it("clears a selected POI once its layer is toggled off (phantom-selection fix)", () => {
			const { rerender } = renderWithContext({});

			// Select the airport POI, as a student browsing the map would.
			const onSelectPoi = mapProps.at(-1)!.onSelectPoi as (poi: typeof AIRPORT_POI) => void;
			act(() => onSelectPoi(AIRPORT_POI));
			expect(screen.getByText("Airport Details")).toBeTruthy();
			expect(mapProps.at(-1)!.selectedPoiId).toBe(1);

			// Master POI switch (or the layer itself) gets disabled in the Layers
			// window: the pin vanishes from the map, so the stale selection must
			// clear rather than leaving the detail pane pointed at a hidden airport.
			mockAppData.current = { poiSettings: { enabled: false, disabledLayers: [] } };
			act(() => {
				rerender(
					<MediaStreamContext.Provider value={makeCtxValue({})}>
						<FlightTracker />
					</MediaStreamContext.Provider>,
				);
			});

			expect(screen.queryByText("Airport Details")).toBeNull();
			expect(mapProps.at(-1)!.selectedPoiId).toBeNull();
		});

		it("clears a selected POI when its layer is unclustered and it isn't a Large hub (largest-only filter)", () => {
			const { rerender } = renderWithContext({});

			// Select the airport POI, as a student browsing the map would. AIRPORT_POI
			// has details: null (not a Large hub), so it renders fine while its layer
			// is clustered but is filtered out by unclusteredAirportFilter once that
			// layer is switched to unclustered.
			const onSelectPoi = mapProps.at(-1)!.onSelectPoi as (poi: typeof AIRPORT_POI) => void;
			act(() => onSelectPoi(AIRPORT_POI));
			expect(screen.getByText("Airport Details")).toBeTruthy();
			expect(mapProps.at(-1)!.selectedPoiId).toBe(1);

			// Turn clustering off for "Major Airports" in the Layers window. The base
			// map now applies the unclustered "largest hub only" filter and hides this
			// non-Large airport — the always-on-top selected overlay must not keep
			// rendering it, so the stale selection has to clear too. (enabledPois is
			// unchanged here — only unclusteredLayers moved — so this only clears if
			// the prune checks the actually-rendered set, not raw enabledPois.)
			mockAppData.current = {
				poiSettings: { enabled: true, disabledLayers: [], unclusteredLayers: ["Major Airports"] },
			};
			act(() => {
				rerender(
					<MediaStreamContext.Provider value={makeCtxValue({})}>
						<FlightTracker />
					</MediaStreamContext.Provider>,
				);
			});

			expect(screen.queryByText("Airport Details")).toBeNull();
			expect(mapProps.at(-1)!.selectedPoiId).toBeNull();
		});

		it("passes poiLayers to FlightMap (one config for the airports layer, clustered by default)", () => {
			// useMapPois is already mocked to one airport POI (layer "Major Airports").
			renderWithContext({});
			const layers = mapProps.at(-1)!.poiLayers as Array<{ layer: string; clustered: boolean }>;
			expect(layers).toHaveLength(1);
			expect(layers[0]).toMatchObject({ layer: "Major Airports", clustered: true });
		});
	});
});
