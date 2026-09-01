// packages/frontend/src/Mobile/IpodShell.test.tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaStreamContextValue } from "../Providers/MediaStream/MediaStreamContext";
import { MediaStreamContext } from "../Providers/MediaStream/MediaStreamContext";
import IpodShell from "./IpodShell";
import { holdSeekStepMs } from "./holdSeekRamp";
import {
	clearAudioBlocked,
	markAudioBlocked,
} from "../Applications/radio-core/audioBlocked";

// Mutated per-test to drive forced-clock enforcement (see PlaylistProvider.test.tsx
// for the same mutable-mock convention).
let mockDateTimeLocked = false;
const mockPause = vi.fn();
const mockResume = vi.fn();
const mockSetDateTime = vi.fn();

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	// localDate is the DISPLAY value classicy's ticking clock returns (UTC
	// shifted by tzOffset -4) — useFineClock strips the offset back off via
	// virtualUtcMs to recover the true UTC instant (12:40 UTC here).
	useClassicyDateTime: () => ({
		dateTime: "2001-09-11T12:40:00.000Z",
		localDate: new Date("2001-09-11T08:40:00.000Z"),
		paused: false,
		tzOffset: -4,
		setDateTime: mockSetDateTime,
		pause: mockPause,
		resume: mockResume,
	}),
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: { Manager: { DateAndTime: { dateTimeLocked: mockDateTimeLocked } } },
		}),
	// jsdom can't run hls.js; the shell tests only care about mount/unmount.
	QuickTimeVideoEmbed: () => <div data-testid="qt-embed" />,
}));

vi.mock("../Applications/radio-core/StationPlayer", () => ({
	StationPlayer: () => <div data-testid="station-player" />,
}));

// Now Playing fetches station artwork from Directus via this hook; tests
// must not hit the network.
vi.mock("../Applications/radio-core/stationLogos", () => ({
	useStationLogos: () => ({}),
}));

afterEach(() => {
	cleanup();
	mockDateTimeLocked = false;
	mockPause.mockClear();
	mockResume.mockClear();
	mockSetDateTime.mockClear();
	clearAudioBlocked("test-banner");
	// Tuning persists the now-playing source (nowPlayingStore.ts); clear it so
	// one test's tuned station never boots the next test's shell pre-tuned.
	window.localStorage.clear();
});
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// The context's default value (not exported) already provides no-op
// subscribe functions and empty data with connected: false. Reading it via
// useContext outside any provider and re-providing with overrides gives a
// full, valid context value without restating all ~40 fields.
function WithStream({
	value,
	children,
}: {
	value: Partial<MediaStreamContextValue>;
	children: React.ReactNode;
}) {
	const base = useContext(MediaStreamContext);
	return (
		<MediaStreamContext.Provider value={{ ...base, ...value }}>
			{children}
		</MediaStreamContext.Provider>
	);
}

const renderShell = (value: Partial<MediaStreamContextValue>) =>
	render(
		<WithStream value={value}>
			<IpodShell />
		</WithStream>,
	);

const TV_ITEM = {
	id: 42, title: "WABC", full_title: "WABC", source: "WABC",
	start_date: "2001-09-11T12:30:00", url: "https://example.test/wabc.m3u8",
	format: "m3u8", approved: 1, mute: 0, volume: 1, jump: 0, trim: 0,
};
const RADIO_ITEM = {
	id: 7, title: "WINS", full_title: "WINS", source: "WINS",
	start_date: "2001-09-11T12:30:00", end_date: "2001-09-11T13:30:00",
	url: "https://example.test/wins.mp3", format: "mp3",
	approved: 1, mute: 0, volume: 1, jump: 0, trim: 0,
};
const STREAM_UP = {
	connected: true,
	items: [TV_ITEM],
	mp3Items: [RADIO_ITEM],
};

function pressMenu(container: HTMLElement) {
	const wheelEl = container.querySelector("#control-wheel") as HTMLElement;
	const menuBtn = container.querySelector("#menu-btn") as HTMLElement;
	fireEvent.pointerDown(menuBtn, { pointerId: 1, clientX: 0, clientY: 0 });
	fireEvent.pointerUp(wheelEl, { pointerId: 1, clientX: 0, clientY: 0 });
}

function pressWheelButton(container: HTMLElement, btnId: string) {
	const wheelEl = container.querySelector("#control-wheel") as HTMLElement;
	const btn = container.querySelector(btnId) as HTMLElement;
	fireEvent.pointerDown(btn, { pointerId: 1, clientX: 0, clientY: 0 });
	fireEvent.pointerUp(wheelEl, { pointerId: 1, clientX: 0, clientY: 0 });
}

function pressPlayPause(container: HTMLElement) {
	const wheelEl = container.querySelector("#control-wheel") as HTMLElement;
	const playBtn = container.querySelector("#play-pause-btn") as HTMLElement;
	fireEvent.pointerDown(playBtn, { pointerId: 1, clientX: 0, clientY: 0 });
	fireEvent.pointerUp(wheelEl, { pointerId: 1, clientX: 0, clientY: 0 });
}

describe("IpodShell", () => {
	it("shows the main menu with the virtual-clock status bar when connected", () => {
		renderShell({ connected: true });
		expect(screen.getByText("iPod")).toBeTruthy(); // status-bar title
		expect(screen.getByText("Radio")).toBeTruthy();
		expect(screen.getByText("TV")).toBeTruthy();
		expect(screen.getByText("Time Travel")).toBeTruthy();
		expect(screen.getByText("About")).toBeTruthy();
		expect(screen.getByText("8:40 AM")).toBeTruthy(); // 12:40 UTC at -4
	});

	it("shows the menu even while the stream is down (only Radio needs it)", () => {
		renderShell({});
		expect(screen.getByText("Radio")).toBeTruthy();
		expect(screen.getByText("About")).toBeTruthy();
		expect(screen.queryByText("Connecting…")).toBeNull();
	});

	it("shows Connecting… on the Radio screen while the stream is down", () => {
		renderShell({});
		fireEvent.click(screen.getByText("Radio"));
		expect(screen.getByText("Connecting…")).toBeTruthy();
	});

	it("navigates to About on tap and back via MENU", () => {
		const { container } = renderShell({ connected: true });
		fireEvent.click(screen.getByText("About"));
		expect(screen.getByText(/adapted from mitchivin/)).toBeTruthy();
		pressMenu(container);
		expect(screen.getByText("Radio")).toBeTruthy(); // back on the menu
	});
});

describe("IpodShell TV", () => {
	it("navigates Menu → TV and lists channels", () => {
		renderShell(STREAM_UP);
		fireEvent.click(screen.getByText("TV"));
		expect(screen.getByText("WABC")).toBeTruthy();
	});

	it("tuning a channel mounts the player and opens Now Playing", () => {
		renderShell(STREAM_UP);
		fireEvent.click(screen.getByText("TV"));
		fireEvent.click(screen.getByText("WABC"));
		expect(screen.getByTestId("qt-embed")).toBeTruthy();
		expect(screen.getByText("Now Playing")).toBeTruthy(); // header title
		expect(document.querySelector(".ipodTvPlayerHidden")).toBeNull();
	});

	it("keeps the TV player mounted — audio alive — after backing out with MENU", () => {
		const { container } = renderShell(STREAM_UP);
		fireEvent.click(screen.getByText("TV"));
		fireEvent.click(screen.getByText("WABC"));
		pressMenu(container); // Now Playing → TV list
		expect(screen.getByTestId("qt-embed")).toBeTruthy(); // still mounted…
		expect(document.querySelector(".ipodTvPlayerHidden")).toBeTruthy(); // …just hidden
	});

	it("tuning TV silences the radio and vice versa", () => {
		const { container } = renderShell(STREAM_UP);
		// Tune radio first.
		fireEvent.click(screen.getByText("Radio"));
		fireEvent.click(screen.getByText("WINS"));
		expect(screen.getByTestId("station-player")).toBeTruthy();
		expect(screen.queryByTestId("qt-embed")).toBeNull();
		// Back out to the menu (Now Playing → Radio → menu) and tune TV.
		pressMenu(container);
		pressMenu(container);
		fireEvent.click(screen.getByText("TV"));
		fireEvent.click(screen.getByText("WABC"));
		expect(screen.getByTestId("qt-embed")).toBeTruthy();
		expect(screen.queryByTestId("station-player")).toBeNull();
		// And back to radio again — TV player unmounts.
		pressMenu(container);
		pressMenu(container);
		fireEvent.click(screen.getByText("Radio"));
		fireEvent.click(screen.getByText("WINS"));
		expect(screen.getByTestId("station-player")).toBeTruthy();
		expect(screen.queryByTestId("qt-embed")).toBeNull();
	});
});

describe("IpodShell forced clock", () => {
	it("evicts back to the menu when the clock becomes forced while on Time Travel", () => {
		const { rerender } = renderShell({ connected: true });
		fireEvent.click(screen.getByText("Time Travel"));
		expect(screen.getByText("Bookmarks")).toBeTruthy(); // on the Time Travel screen

		mockDateTimeLocked = true;
		rerender(
			<WithStream value={{ connected: true }}>
				<IpodShell />
			</WithStream>,
		);
		expect(screen.getByText("Radio")).toBeTruthy(); // back on the main menu
		expect(screen.queryByText("Bookmarks")).toBeNull();
	});

	it("evicts back to the menu (cascading pops) when forced while on a nested Bookmarks/Scrub screen", () => {
		const { rerender } = renderShell({ connected: true });
		fireEvent.click(screen.getByText("Time Travel"));
		fireEvent.click(screen.getByText("Scrub Time"));
		expect(screen.getByText("Scrub")).toBeTruthy(); // header title of the Scrub screen

		mockDateTimeLocked = true;
		rerender(
			<WithStream value={{ connected: true }}>
				<IpodShell />
			</WithStream>,
		);
		expect(screen.getByText("Radio")).toBeTruthy(); // cascaded all the way back
	});

	it("makes the wheel's play/pause a no-op while the clock is forced", () => {
		mockDateTimeLocked = true;
		const { container } = renderShell({ connected: true });
		pressPlayPause(container);
		expect(mockPause).not.toHaveBeenCalled();
		expect(mockResume).not.toHaveBeenCalled();
	});

	it("wheel play/pause still works when the clock is not forced", () => {
		const { container } = renderShell({ connected: true });
		pressPlayPause(container);
		expect(mockPause).toHaveBeenCalledTimes(1); // mocked paused: false → pause()
		expect(mockResume).not.toHaveBeenCalled();
	});
});

// A refreshed/reopened phone resumes the tuned source: the shell seeds
// nowPlaying from nowPlayingStore (localStorage) and writes every change
// back. The virtual clock itself survives reloads via classicy's persisted
// store, so restoring the source is what makes "close and reopen" come back
// playing the same station at the same moment.
describe("IpodShell now-playing persistence", () => {
	it("restores a persisted radio station on boot", () => {
		window.localStorage.setItem(
			"rt911IpodNowPlaying",
			JSON.stringify({ kind: "radio", key: "WINS" }),
		);
		renderShell(STREAM_UP);
		expect(screen.getByTestId("station-player")).toBeTruthy();
		expect(screen.queryByTestId("qt-embed")).toBeNull();
	});

	it("restores a persisted TV channel on boot (hidden on the menu, audio alive)", () => {
		window.localStorage.setItem(
			"rt911IpodNowPlaying",
			JSON.stringify({ kind: "tv", id: 42 }),
		);
		renderShell(STREAM_UP);
		expect(screen.getByTestId("qt-embed")).toBeTruthy();
		// Boot lands on the menu; the player is mounted but hidden, same as
		// backing out of Now Playing with MENU.
		expect(document.querySelector(".ipodTvPlayerHidden")).toBeTruthy();
	});

	it("boots untuned when the persisted source references nothing in the stream", () => {
		window.localStorage.setItem(
			"rt911IpodNowPlaying",
			JSON.stringify({ kind: "tv", id: 999 }),
		);
		renderShell(STREAM_UP);
		expect(screen.queryByTestId("qt-embed")).toBeNull();
		expect(screen.queryByTestId("station-player")).toBeNull();
	});

	it("persists tuning so the next boot can restore it", () => {
		renderShell(STREAM_UP);
		fireEvent.click(screen.getByText("TV"));
		fireEvent.click(screen.getByText("WABC"));
		expect(
			JSON.parse(window.localStorage.getItem("rt911IpodNowPlaying") ?? "null"),
		).toEqual({ kind: "tv", id: 42 });
	});
});

// ⏮/⏭ drive the virtual clock: a tap skips 30 seconds, hold-repeat ticks
// skip with acceleration (holdSeekRamp.ts), and everything goes through the
// setDateTimeFromUtc seam (asserted here via the classicy setDateTime
// callback it wraps). The mocked clock is pinned at 12:40:00 UTC, so
// expected targets are absolute.
describe("IpodShell wheel time skips", () => {
	const NOW = Date.parse("2001-09-11T12:40:00.000Z");

	it("tapping ⏭ skips the clock forward 30 seconds", () => {
		const { container } = renderShell({ connected: true });
		pressWheelButton(container, "#next-btn");
		expect(mockSetDateTime).toHaveBeenCalledTimes(1);
		expect(+mockSetDateTime.mock.calls[0][0]).toBe(NOW + 30_000);
	});

	it("tapping ⏮ skips the clock back 30 seconds", () => {
		const { container } = renderShell({ connected: true });
		pressWheelButton(container, "#prev-btn");
		expect(mockSetDateTime).toHaveBeenCalledTimes(1);
		expect(+mockSetDateTime.mock.calls[0][0]).toBe(NOW - 30_000);
	});

	it("holding ⏭ repeats accelerating skips and suppresses the 30s tap", () => {
		vi.useFakeTimers();
		const { container } = renderShell({ connected: true });
		const wheelEl = container.querySelector("#control-wheel") as HTMLElement;
		const btn = container.querySelector("#next-btn") as HTMLElement;
		fireEvent.pointerDown(btn, { pointerId: 1, clientX: 0, clientY: 0 });
		vi.advanceTimersByTime(550 + 500); // HOLD_DELAY_MS + one HOLD_REPEAT_MS
		fireEvent.pointerUp(wheelEl, { pointerId: 1, clientX: 0, clientY: 0 });
		vi.useRealTimers();
		expect(mockSetDateTime).toHaveBeenCalledTimes(2); // two hold ticks, no tap
		// The mocked clock is pinned at 12:40, so each tick's target is exactly
		// the ramp step for its heldMs: 0 held → 1 min, 500ms held → a bit more.
		expect(+mockSetDateTime.mock.calls[0][0]).toBe(NOW + holdSeekStepMs(0, 500));
		expect(+mockSetDateTime.mock.calls[1][0]).toBe(NOW + holdSeekStepMs(500, 500));
		expect(holdSeekStepMs(500, 500)).toBeGreaterThan(holdSeekStepMs(0, 500));
	});

	it("is inert while the streamer's forced clock is active", () => {
		mockDateTimeLocked = true;
		const { container } = renderShell({ connected: true });
		pressWheelButton(container, "#next-btn");
		pressWheelButton(container, "#prev-btn");
		expect(mockSetDateTime).not.toHaveBeenCalled();
	});
});

// iOS refuses gesture-less audio after a reload — a policy that cannot be
// bypassed — so the shell must at least SAY so. StationPlayer marks the
// shared audioBlocked signal while the gate holds playback; the shell shows
// a banner that doubles as the instruction (any tap retries playback).
describe("IpodShell tap-to-start banner", () => {
	it("appears while audio is autoplay-blocked and leaves when it clears", () => {
		renderShell(STREAM_UP);
		expect(screen.queryByText(/Tap anywhere to start audio/)).toBeNull();
		act(() => markAudioBlocked("test-banner"));
		expect(screen.getByText(/Tap anywhere to start audio/)).toBeTruthy();
		act(() => clearAudioBlocked("test-banner"));
		expect(screen.queryByText(/Tap anywhere to start audio/)).toBeNull();
	});
});

// Settings → Color: the pick lands as data-ipod-color on .ipodRoot (where
// shell.css retints the vendored artwork) and persists across reloads via
// ipodColorStore (localStorage is cleared between tests above).
describe("IpodShell color setting", () => {
	it("boots silver, recolors via Settings → Color, and persists the pick", () => {
		const { container } = renderShell({ connected: true });
		const root = container.querySelector(".ipodRoot") as HTMLElement;
		expect(root.getAttribute("data-ipod-color")).toBe("silver");

		fireEvent.click(screen.getByText("Settings"));
		fireEvent.click(screen.getByText("Color"));
		fireEvent.click(screen.getByText("Pink"));

		expect(root.getAttribute("data-ipod-color")).toBe("pink");
		// The checkmark follows the pick, iPod-settings style.
		expect(screen.getByText("✓").closest("li")?.textContent).toContain("Pink");
		expect(window.localStorage.getItem("rt911IpodColor")).toBe("pink");
	});

	it("boots with a previously saved color", () => {
		window.localStorage.setItem("rt911IpodColor", "gold");
		const { container } = renderShell({ connected: true });
		expect(
			container.querySelector(".ipodRoot")?.getAttribute("data-ipod-color"),
		).toBe("gold");
	});
});
