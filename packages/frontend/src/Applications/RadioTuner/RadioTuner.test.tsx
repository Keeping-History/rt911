import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearAudioBlocked,
	markAudioBlocked,
} from "../radio-core/audioBlocked";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../Providers/MediaStream/MediaStreamContext";

// Stub the playback-heavy children — this suite only asserts the tuner's
// station partition and settings chrome around them.
const stationPlayerProps = vi.hoisted(
	() => ({ current: null as Record<string, unknown> | null }),
);
vi.mock("../radio-core/StationPlayer", () => ({
	StationPlayer: (props: Record<string, unknown>) => {
		stationPlayerProps.current = props;
		return <div data-testid="station-player" />;
	},
}));
vi.mock("./NowPlayingList", () => ({
	NowPlayingList: () => <div data-testid="now-playing" />,
}));
vi.mock("../../openreplay", () => ({
	trackAppToggle: () => {},
}));
// The station-logo map is a Directus read; stub it so the suite never touches
// the network and each test can state exactly which stations have artwork.
const mockStationLogos = vi.hoisted(
	() => ({ current: {} as Record<string, string> }),
);
vi.mock("../radio-core/stationLogos", () => ({
	useStationLogos: () => mockStationLogos.current,
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
	ClassicyControlLabel: ({ label }: { label?: string }) => (
		<span>{label}</span>
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
	ClassicySlider: ({
		id,
		value,
		min,
		max,
		step,
		tickInterval,
		onChangeFunc,
	}: {
		id?: string;
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		tickInterval?: number | "center";
		onChangeFunc?: (e: React.ChangeEvent<HTMLInputElement>) => void;
	}) => (
		<input
			type="range"
			data-testid={id}
			value={value}
			min={min}
			max={max}
			step={step}
			data-tick-interval={tickInterval}
			onChange={onChangeFunc}
		/>
	),
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
	ClassicyBalloonHelp: ({
		content,
		children,
	}: {
		content?: string;
		children?: React.ReactNode;
	}) => (
		<div data-balloon-content={content}>
			{children}
		</div>
	),
	ClassicyIcons: {
		applications: { radio: { app: "radio.png" } },
		controlPanels: { soundManager: { sound33: "sound.png" } },
	},
	quitMenuItemHelper: () => ({}),
	registerAppEventHandler: () => {},
	registerApp: () => {},
	getAppManifest: () => undefined,
	useClassicyHelpMenu: () => {},
	intToHex: (c: number) => `#${c.toString(16).padStart(6, "0")}`,
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: {
				Manager: {
					Applications: {
						apps: {
							"RadioTuner.app": {
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

import { RadioTuner } from "./RadioTuner";

function item(
	id: number,
	source: string,
	start: string,
	over: Partial<MediaItem> = {},
): MediaItem {
	return {
		id,
		title: `${source} broadcast ${id}`,
		full_title: `${source} broadcast ${id}`,
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

function renderTuner(
	data: Record<string, unknown> = {},
	mp3Items: MediaItem[] = [
		item(1, "WINS", "2001-09-11T12:30:00.000Z"),
		item(2, "WCBS", "2001-09-11T12:30:00.000Z"),
		item(3, "ATC", "2001-09-11T12:30:00.000Z"),
	],
	upcomingItems: MediaItem[] = [],
	audioSources: string[] = ["WINS", "WCBS", "ATC"],
): void {
	mockAppData.current = data;
	const ctx: Partial<MediaStreamContextValue> = {
		mp3Items,
		mp3History: [],
		sources: {
			video: [],
			audio: audioSources,
			pager: [],
			usenet: [],
		},
		subscribeMp3: () => {},
		unsubscribeMp3: () => {},
		getUpcomingMp3Items: () => upcomingItems,
	};
	render(
		<MediaStreamContext.Provider value={ctx as MediaStreamContextValue}>
			<RadioTuner />
		</MediaStreamContext.Provider>,
	);
}

describe("RadioTuner station partition", () => {
	afterEach(() => {
		mockDispatch.mockClear();
		stationPlayerProps.current = null;
		cleanup();
	});

	it("lists only the broadcast stations in the strip", () => {
		renderTuner();
		// WINS renders twice (display + strip button) — the point is presence.
		expect(screen.getAllByText("WINS").length).toBeGreaterThan(0);
		expect(screen.getAllByText("WCBS").length).toBeGreaterThan(0);
		expect(screen.queryByText("ATC")).toBeNull();
	});

	it("selects the first broadcast station by default and feeds it to the player", () => {
		renderTuner();
		const station = stationPlayerProps.current?.station as {
			key: string;
			items: MediaItem[];
		};
		expect(station.key).toBe("WINS");
		expect(station.items.map((i) => i.id)).toEqual([1]);
	});

	it("has no Coming Up schedule or All Traffic aggregate", () => {
		renderTuner();
		expect(screen.queryByText("Coming Up")).toBeNull();
		expect(screen.queryByText("Previous")).toBeNull();
		expect(screen.queryByText("All Traffic")).toBeNull();
	});

	it("tunes another station from its strip button", () => {
		renderTuner();
		fireEvent.click(screen.getByText("WCBS"));
		const station = stationPlayerProps.current?.station as { key: string };
		expect(station.key).toBe("WCBS");
	});

	it("applies a remote tune command case-insensitively", () => {
		renderTuner({ command: { seq: 1, kind: "tune", station: "wcbs" } });
		const station = stationPlayerProps.current?.station as { key: string };
		expect(station.key).toBe("WCBS");
	});
});

describe("RadioTuner station logo", () => {
	afterEach(() => {
		mockDispatch.mockClear();
		stationPlayerProps.current = null;
		mockStationLogos.current = {};
		cleanup();
	});

	it("shows the tuned station's artwork (mp3_items.image) instead of the text call sign", () => {
		renderTuner({}, [
			item(1, "WINS", "2001-09-11T12:30:00.000Z", {
				image: "https://files.911realtime.org/images/radio/wins.png",
			}),
			item(2, "WCBS", "2001-09-11T12:30:00.000Z"),
		]);
		const logo = screen.getByAltText("WINS") as HTMLImageElement;
		expect(logo.src).toBe(
			"https://files.911realtime.org/images/radio/wins.png",
		);
		// The call sign still labels the strip button, but the display header
		// text is replaced by the artwork.
		expect(screen.getAllByText("WINS")).toHaveLength(1);
	});

	it("falls back to the text call sign when no row carries artwork", () => {
		renderTuner();
		expect(screen.queryByAltText("WINS")).toBeNull();
		// Display header + strip button.
		expect(screen.getAllByText("WINS").length).toBeGreaterThan(1);
	});

	// A station holding a single recording is dark for most of the virtual day,
	// so the streamed items carry no artwork — the identity has to come from
	// the station map or the display falls back to bare text.
	it("shows a dark station's logo from the station map, dimmed and desaturated", () => {
		mockStationLogos.current = {
			WINS: "https://files.911realtime.org/images/radio/wins.png",
		};
		renderTuner({}, [item(3, "ATC", "2001-09-11T12:30:00.000Z")]);
		const logo = screen.getByAltText("WINS") as HTMLImageElement;
		expect(logo.src).toBe(
			"https://files.911realtime.org/images/radio/wins.png",
		);
		expect(logo.className).toContain("rsDisplayLogoOffline");
	});

	it("leaves an on-air station's logo at full color", () => {
		mockStationLogos.current = {
			WINS: "https://files.911realtime.org/images/radio/wins.png",
		};
		renderTuner({}, [
			item(1, "WINS", "2001-09-11T12:30:00.000Z", {
				image: "https://files.911realtime.org/images/radio/wins.png",
			}),
		]);
		const logo = screen.getByAltText("WINS") as HTMLImageElement;
		expect(logo.className).toContain("rsDisplayLogo");
		expect(logo.className).not.toContain("rsDisplayLogoOffline");
	});
});

describe("RadioTuner upcoming countdown", () => {
	afterEach(() => {
		mockDispatch.mockClear();
		stationPlayerProps.current = null;
		cleanup();
	});

	// The mocked useClassicyDateTime reports the clock as paused, so
	// RadioTuner's fine clock (getNowMs) contributes zero real-time elapsed —
	// nowMs is pinned to 2001-09-11T12:40:00.000Z for every test in this file.

	it("shows a Starts-in balloon over an upcoming station's strip button, and none over an on-air one", () => {
		renderTuner(
			{},
			[item(1, "WINS", "2001-09-11T12:30:00.000Z")],
			[item(4, "WOR", "2001-09-11T12:41:04.000Z")],
			["WINS", "WOR"],
		);

		// WOR has nothing on air yet but one queued item 64s out — its strip
		// button should sit inside a balloon reading the formatted countdown.
		const worLabel = screen.getByText("WOR");
		const worBalloon = worLabel.closest("[data-balloon-content]");
		expect(worBalloon).not.toBeNull();
		expect(worBalloon?.getAttribute("data-balloon-content")).toBe(
			"Starts in 01:04",
		);

		// WINS is on-air (active by default) — its strip button label carries
		// no balloon at all.
		const winsStripLabel = screen
			.getAllByText("WINS")
			.find((el) => el.className.includes("rsStationSource"));
		expect(winsStripLabel).toBeDefined();
		expect(winsStripLabel?.closest("[data-balloon-content]")).toBeNull();
	});

	it("shows no balloon over an offline station's strip button", () => {
		// WCBS is in the source list but carries neither an active nor an
		// upcoming item — offline, not upcoming, so no balloon at all.
		renderTuner(
			{},
			[item(1, "WINS", "2001-09-11T12:30:00.000Z")],
			[],
			["WINS", "WCBS"],
		);
		const wcbsLabel = screen.getByText("WCBS");
		expect(wcbsLabel.closest("[data-balloon-content]")).toBeNull();
	});

	it("shows a countdown line under the logo when the active station is upcoming", () => {
		renderTuner(
			{},
			[],
			[item(4, "WOR", "2001-09-11T12:41:04.000Z")],
			["WOR"],
		);
		expect(screen.getByText("Starts in 01:04")).toBeTruthy();
	});

	it("shows no countdown line under the logo when the active station is on-air", () => {
		renderTuner();
		expect(screen.queryByText(/Starts in/)).toBeNull();
	});
});

describe("RadioTuner audio-unlock overlay", () => {
	afterEach(() => {
		clearAudioBlocked("test-gate");
		cleanup();
	});

	it("appears while audio is gesture-blocked and leaves once unblocked", () => {
		renderTuner();
		expect(screen.queryByText(/click anywhere to start audio/i)).toBeNull();
		act(() => markAudioBlocked("test-gate"));
		expect(screen.getByText(/click anywhere to start audio/i)).toBeTruthy();
		act(() => clearAudioBlocked("test-gate"));
		expect(screen.queryByText(/click anywhere to start audio/i)).toBeNull();
	});
});

describe("RadioTuner settings", () => {
	afterEach(() => {
		mockDispatch.mockClear();
		stationPlayerProps.current = null;
		cleanup();
	});

	it("passes default settings (Wave, theme colors) to StationPlayer", () => {
		renderTuner();
		expect(stationPlayerProps.current).toMatchObject({
			vizMode: "Wave",
			waveColors: null,
			maxVolume: 1,
		});
	});

	it("cycling the viz mode dispatches a tuner-namespaced settings update", () => {
		renderTuner();
		const cycle = stationPlayerProps.current?.onCycleVizMode as () => void;
		act(() => cycle());
		expect(mockDispatch).toHaveBeenCalledWith({
			type: "ClassicyAppRadioTunerSetSettings",
			settings: expect.objectContaining({ vizMode: "Bars" }), // Wave → Bars
		});
	});

	it("opens Settings from the menu, saves a new mode, and closes", () => {
		renderTuner();
		expect(screen.queryByText("Save")).toBeNull();
		fireEvent.click(screen.getAllByText("Settings…")[0]);
		fireEvent.click(screen.getByText("Bars"));
		fireEvent.click(screen.getByText("Save"));
		expect(mockDispatch).toHaveBeenCalledWith({
			type: "ClassicyAppRadioTunerSetSettings",
			settings: expect.objectContaining({ vizMode: "Bars" }),
		});
		expect(screen.queryByText("Save")).toBeNull();
	});

	it("persists state under the tuner's own action namespace", () => {
		renderTuner();
		expect(mockDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ClassicyAppRadioTunerSetState",
				activeStation: "WINS",
			}),
		);
	});
});
