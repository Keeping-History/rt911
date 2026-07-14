import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAudioBlocked, markAudioBlocked } from "./audioBlocked";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../Providers/MediaStream/MediaStreamContext";

// Stub the playback-heavy children — this suite only asserts the schedule
// (Coming Up / Previous) chrome around them.
const stationPlayerProps = vi.hoisted(
	() => ({ current: null as Record<string, unknown> | null }),
);
vi.mock("./StationPlayer", () => ({
	StationPlayer: (props: Record<string, unknown>) => {
		stationPlayerProps.current = props;
		return <div data-testid="station-player" />;
	},
}));
vi.mock("./NowPlayingList", () => ({
	NowPlayingList: () => <div data-testid="now-playing" />,
}));
vi.mock("./FocusedItemPlayer", () => ({
	FocusedItemPlayer: () => <div data-testid="focused-player" />,
}));
vi.mock("../../openreplay", () => ({
	trackAppToggle: () => {},
}));

const mockAppData = vi.hoisted(
	() => ({ current: {} as Record<string, unknown> }),
);
const mockDispatch = vi.hoisted(() => vi.fn());

vi.mock("classicy", () => ({
	ClassicyApp: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	ClassicyWindow: ({
		children,
		appMenu,
		title,
	}: {
		children?: React.ReactNode;
		title?: string;
		appMenu?: {
			menuChildren?: {
				id?: string;
				title?: string;
				onClickFunc?: () => void;
			}[];
		}[];
	}) => (
		<div data-window-title={title}>
			{appMenu
				?.flatMap((m) => m.menuChildren ?? [])
				.map((mi, i) =>
					mi.title ? (
						<button
							type="button"
							key={mi.id ?? i}
							onClick={mi.onClickFunc}
						>
							{mi.title}
						</button>
					) : null,
				)}
			{children}
		</div>
	),
	ClassicyControlGroup: ({
		label,
		children,
	}: {
		label?: string;
		children?: React.ReactNode;
	}) => (
		<fieldset>
			<legend>{label}</legend>
			{children}
		</fieldset>
	),
	ClassicyRadioInput: ({
		inputs,
		onClickFunc,
	}: {
		inputs: { id: string; label: string; checked: boolean }[];
		onClickFunc: (id: string) => void;
	}) => (
		<div>
			{inputs.map((i) => (
				<button type="button" key={i.id} onClick={() => onClickFunc(i.id)}>
					{i.label}
				</button>
			))}
		</div>
	),
	ClassicyCheckbox: ({
		label,
		checked,
		onClickFunc,
	}: {
		label?: string;
		checked?: boolean;
		onClickFunc?: (checked: boolean) => void;
	}) => (
		<label>
			<input
				type="checkbox"
				checked={checked ?? false}
				onChange={() => onClickFunc?.(!checked)}
			/>
			{label}
		</label>
	),
	ClassicyColorPicker: ({
		labelTitle,
		value,
	}: {
		labelTitle?: string;
		value?: number;
	}) => <div data-color-value={value}>{labelTitle}</div>,
	MAC_OS_8_CRAYONS: [],
	ClassicyButton: ({
		children,
		onClickFunc,
	}: {
		children?: React.ReactNode;
		onClickFunc?: () => void;
	}) => (
		<button type="button" onClick={onClickFunc}>
			{children}
		</button>
	),
	ClassicyIcons: {
		applications: { radio: { app: "radio.png" } },
		controlPanels: { soundManager: { sound33: "sound.png" } },
	},
	quitMenuItemHelper: () => ({}),
	registerAppEventHandler: () => {},
	intToHex: (c: number) => `#${c.toString(16).padStart(6, "0")}`,
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: {
				Manager: {
					Applications: {
						apps: {
							"RadioScanner.app": {
								open: true,
								data: mockAppData.current,
							},
						},
					},
				},
			},
		}),
	useAppManagerDispatch: () => mockDispatch,
	useClassicyDateTime: () => ({
		dateTime: "2001-09-11T12:40:00.000Z",
		paused: true,
		tzOffset: -4,
	}),
}));

import { RadioScanner } from "./RadioScanner";

const NOW = "2001-09-11T12:40:00.000Z";

function item(
	id: number,
	source: string,
	start: string,
	over: Partial<MediaItem> = {},
): MediaItem {
	return {
		id,
		title: `${source} clip ${id}`,
		full_title: `${source} clip ${id}`,
		source,
		start_date: start,
		calc_duration: 3600,
		url: `https://example.test/${id}.mp3`,
		format: "mp3",
		approved: 1,
		mute: 0,
		volume: 1,
		jump: 0,
		trim: 0,
		...over,
	};
}

function renderScanner(activeStation: string): void {
	mockAppData.current = { activeStation };
	renderScannerWithData();
}

function renderScannerWithData(): void {
	const ctx: Partial<MediaStreamContextValue> = {
		mp3Items: [
			item(1, "WINS", "2001-09-11T12:30:00.000Z"),
			item(2, "WCBS", "2001-09-11T12:30:00.000Z"),
			item(3, "ATC", "2001-09-11T12:30:00.000Z"),
		],
		// One already-ended ATC clip (12:00–12:10 UTC, now is 12:40) for the
		// Previous list.
		mp3History: [
			item(21, "ATC", "2001-09-11T12:00:00.000Z", { calc_duration: 600 }),
		],
		sources: {
			video: [],
			audio: ["WINS", "WCBS", "ATC"],
			pager: [],
			usenet: [],
		},
		subscribeMp3: () => {},
		unsubscribeMp3: () => {},
		// Every station has a pending item, so any Coming Up section that
		// renders would have content — the label's presence is purely the
		// continuous-station gate under test.
		getUpcomingMp3Items: () => [
			item(11, "WINS", "2001-09-11T12:45:00.000Z"),
			item(12, "WCBS", "2001-09-11T12:45:00.000Z"),
			item(13, "ATC", "2001-09-11T12:45:00.000Z"),
		],
	};
	render(
		<MediaStreamContext.Provider value={ctx as MediaStreamContextValue}>
			<RadioScanner />
		</MediaStreamContext.Provider>,
	);
}

describe("RadioScanner schedule visibility", () => {
	afterEach(cleanup);

	it(`shows Coming Up for a scheduled station (now=${NOW})`, () => {
		renderScanner("ATC");
		expect(screen.getByText("Coming Up")).toBeTruthy();
	});

	it("hides Coming Up on WINS (continuous broadcast)", () => {
		renderScanner("WINS");
		expect(screen.queryByText("Coming Up")).toBeNull();
	});

	it("hides Coming Up on WCBS (continuous broadcast)", () => {
		renderScanner("WCBS");
		expect(screen.queryByText("Coming Up")).toBeNull();
	});

	it("labels each Previous item with its start time in the display timezone", () => {
		renderScanner("ATC");
		expect(screen.getByText("Previous")).toBeTruthy();
		// 12:00 UTC shifted by the -4 display offset.
		expect(screen.getByText("9/11, 8:00 AM")).toBeTruthy();
	});
});

describe("RadioScanner audio-unlock overlay", () => {
	afterEach(() => {
		clearAudioBlocked("test-gate");
		cleanup();
	});

	it("appears while audio is gesture-blocked and leaves once unblocked", () => {
		renderScanner("ATC");
		expect(screen.queryByText(/click anywhere to start audio/i)).toBeNull();
		act(() => markAudioBlocked("test-gate"));
		expect(screen.getByText(/click anywhere to start audio/i)).toBeTruthy();
		act(() => clearAudioBlocked("test-gate"));
		expect(screen.queryByText(/click anywhere to start audio/i)).toBeNull();
	});

	it("is already visible on mount when audio was blocked before render", () => {
		markAudioBlocked("test-gate");
		renderScanner("WINS");
		expect(screen.getByText(/click anywhere to start audio/i)).toBeTruthy();
	});
});

describe("RadioScanner waveform settings", () => {
	afterEach(() => {
		mockDispatch.mockClear();
		stationPlayerProps.current = null;
		cleanup();
	});

	it("passes default settings (Wave, theme colors) to StationPlayer", () => {
		renderScanner("ATC");
		expect(stationPlayerProps.current).toMatchObject({
			vizMode: "Wave",
			waveColors: null,
		});
	});

	it("passes stored custom mode and colors to StationPlayer", () => {
		mockAppData.current = {
			activeStation: "ATC",
			settings: {
				vizMode: "Bars",
				useThemeColors: false,
				colorBright: 0xff0000,
				colorDim: 0x330000,
			},
		};
		renderScannerWithData();
		expect(stationPlayerProps.current).toMatchObject({
			vizMode: "Bars",
			waveColors: { bright: "#ff0000", dim: "#330000" },
		});
	});

	it("cycling the viz mode dispatches a persisted settings update", () => {
		renderScanner("ATC");
		const cycle = stationPlayerProps.current
			?.onCycleVizMode as () => void;
		act(() => cycle());
		expect(mockDispatch).toHaveBeenCalledWith({
			type: "ClassicyAppRadioScannerSetSettings",
			settings: expect.objectContaining({ vizMode: "Bars" }), // Wave → Bars
		});
	});
});

describe("RadioScanner Settings window", () => {
	afterEach(() => {
		mockDispatch.mockClear();
		cleanup();
	});

	it("opens from the menu, saves a new mode, and closes", () => {
		renderScanner("ATC");
		expect(screen.queryByText("Save")).toBeNull();
		fireEvent.click(screen.getAllByText("Settings…")[0]);
		fireEvent.click(screen.getByText("Bars"));
		fireEvent.click(screen.getByText("Save"));
		expect(mockDispatch).toHaveBeenCalledWith({
			type: "ClassicyAppRadioScannerSetSettings",
			settings: expect.objectContaining({ vizMode: "Bars" }),
		});
		expect(screen.queryByText("Save")).toBeNull();
	});

	it("Cancel discards the draft without dispatching settings", () => {
		renderScanner("ATC");
		fireEvent.click(screen.getAllByText("Settings…")[0]);
		fireEvent.click(screen.getByText("Bars"));
		fireEvent.click(screen.getByText("Cancel"));
		expect(
			mockDispatch.mock.calls.filter(
				([a]) => a.type === "ClassicyAppRadioScannerSetSettings",
			),
		).toHaveLength(0);
	});

	it("shows the color pickers only when theme colors are off", () => {
		renderScanner("ATC");
		fireEvent.click(screen.getAllByText("Settings…")[0]);
		expect(screen.queryByText("Bright")).toBeNull();
		fireEvent.click(screen.getByLabelText("Use theme colors"));
		expect(screen.getByText("Bright")).toBeTruthy();
		expect(screen.getByText("Dim")).toBeTruthy();
	});
});
