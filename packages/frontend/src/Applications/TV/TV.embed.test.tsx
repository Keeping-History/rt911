import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

const captured = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
// Seeded TV.app data handed to useAppManager; tests may override, reset in afterEach.
const mockAppData = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
// Optional items override for the useMediaStream mock (null → default [FAKE_ITEM]).
const mockItems = vi.hoisted(() => ({ value: null as unknown[] | null }));

const FAKE_ITEM = {
	id: 7,
	url: "https://files.example.org/wabc/index.m3u8",
	source: "WABC",
	start_date: "2001-09-11T12:00:00",
	jump: 0,
	subtitles: "https://files.example.org/wabc/subs.srt",
} as unknown as MediaItem;

const FAKE_ITEM_2 = {
	id: 8,
	url: "https://files.example.org/wnbc/index.m3u8",
	source: "WNBC",
	start_date: "2001-09-11T12:00:00",
	jump: 0,
	subtitles: "https://files.example.org/wnbc/subs.srt",
} as unknown as MediaItem;

vi.mock("classicy", async (importOriginal) => {
	const actual = await importOriginal<typeof import("classicy")>();
	// Built per call so a test's mockAppData override is visible to the selector.
	const fakeState = () => ({
		System: {
			Manager: {
				Applications: {
					apps: {
						"TV.app": { data: mockAppData.value, open: true, windows: [] },
					},
				},
			},
		},
	});
	return {
		...actual,
		ClassicyApp: ({ children }: { children?: React.ReactNode }) => (
			<div>{children}</div>
		),
		ClassicyWindow: ({ children }: { children?: React.ReactNode }) => (
			<div>{children}</div>
		),
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
		ClassicySlider: () => <input type="range" readOnly />,
		QuickTimeVideoEmbed: (props: Record<string, unknown>) => {
			captured.props.push(props);
			return <div data-testid="qt-embed" />;
		},
		useAppManager: (selector: (s: unknown) => unknown) => selector(fakeState()),
		useAppManagerDispatch: () => () => {},
		useClassicyDateTime: () => ({
			dateTime: "2001-09-11T12:40:00.000Z",
			paused: false,
		}),
	};
});

vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({
		items: mockItems.value ?? [FAKE_ITEM],
		sources: { video: ["WABC", "WNBC"], audio: [], pager: [], usenet: [] },
	}),
}));

vi.mock("../../openreplay", () => ({
	trackAppToggle: () => {},
	trackChannelChange: () => {},
}));

import { TV } from "./TV";
import { DEFAULT_CAPTION_STYLE } from "./TVContext";

afterEach(() => {
	cleanup();
	mockAppData.value = {};
	mockItems.value = null;
});
afterEach(() => vi.useRealTimers());

type FakeApi = {
	autoLevelCapping: number;
	autoLevelEnabled: boolean;
	bandwidthEstimate: number;
	currentLevel: number;
	loadLevel: number;
	nextLevel: number;
	nextLoadLevel: number;
	once: (event: string, cb: () => void) => void;
};

/** Plain-object stand-in for the <hls-video> element QuickTimeVideoEmbed
 *  registers via onMediaElement — jsdom's HTMLMediaElement lacks play(). */
function fakeHlsElement() {
	const handlers: Record<string, (() => void)[]> = {};
	const api: FakeApi = {
		autoLevelCapping: -1,
		autoLevelEnabled: true,
		bandwidthEstimate: 500_000,
		currentLevel: 0,
		loadLevel: 0,
		nextLevel: -1,
		nextLoadLevel: 0,
		once: (event, cb) => {
			(handlers[event] ??= []).push(cb);
		},
	};
	const el = {
		api,
		paused: false,
		ended: false,
		currentTime: 2400,
		buffered: { length: 1, start: () => 0, end: () => 4000 },
		play: () => Promise.resolve(),
	} as unknown as HTMLVideoElement;
	return { el, api, handlers };
}

describe("TV — props handed to QuickTimeVideoEmbed", () => {
	it("drives the embed as a fully controlled, chrome-less, caption-styled player", () => {
		render(<TV />);
		expect(captured.props.length).toBeGreaterThan(0);
		const p = captured.props[captured.props.length - 1];

		expect(p.hideControls).toBe(true);
		expect(p.playing).toBe(true); // clock running, TV not paused
		expect(p.muted).toBe(true); // no user interaction yet → autoplay-safe
		expect(p.volume).toBe(1); // default volumeLimit
		expect(p.captionsEnabled).toBe(false); // default captionsOn
		expect(p.captionStyle).toEqual(DEFAULT_CAPTION_STYLE);
		expect(p.subtitlesUrl).toBe("https://files.example.org/wabc/subs.vtt");
		expect(p.crossOrigin).toBe("anonymous");
		expect(p.playsInline).toBe(true);
		expect(typeof p.onMediaElement).toBe("function");
		expect(typeof p.onReady).toBe("function");
	});

	it("hands every hls player the upward-biased ABR config", () => {
		captured.props.length = 0;
		render(<TV />);
		const p = captured.props[captured.props.length - 1];
		const hls = (p.options as { hls: Record<string, unknown> }).hls;

		expect(hls).toMatchObject({
			abrEwmaDefaultEstimate: 5_000_000,
			abrBandWidthUpFactor: 0.9,
			abrEwmaFastVoD: 2,
			abrEwmaSlowVoD: 5,
		});
		// The pre-existing per-item fields must survive the spread.
		expect(hls.startLevel).toBe(2); // single view starts at full
		expect(typeof hls.startPosition).toBe("number");
	});

	it("aggressively bumps the focused single view to full on ready, then restores auto", () => {
		captured.props.length = 0;
		render(<TV />);
		const p = captured.props[captured.props.length - 1];
		const { el, api, handlers } = fakeHlsElement();

		(p.onMediaElement as (el: unknown) => void)(el);
		act(() => {
			(p.onReady as () => void)();
		});

		expect(api.autoLevelCapping).toBe(2); // ceiling: single view = full
		expect(api.bandwidthEstimate).toBe(5_000_000); // optimistic reset
		expect(api.nextLevel).toBe(2); // forced switch (flushes low-res buffer)
		handlers.hlsLevelSwitched[0]();
		expect(api.nextLevel).toBe(-1); // auto restored — a nudge, not a pin
	});

	it("bumps an already-mounted grid player whose tier rises to HIGHEST when the grid shrinks to one", () => {
		captured.props.length = 0;
		mockAppData.value = { multiSelectMode: true, selectedPlayers: [7, 8] };
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);

		// Two grid players mounted; register a fake hls element for item 7.
		const p7 = captured.props.find((p) => p.name === "WABC");
		if (!p7) throw new Error("WABC grid player not mounted");
		const { el, api, handlers } = fakeHlsElement();
		(p7.onMediaElement as (el: unknown) => void)(el);

		// Two-player grid → item 7 sits at ONE_DOWN; no bump has fired yet.
		expect(api.bandwidthEstimate).toBe(500_000);
		expect(api.nextLevel).toBe(-1);

		// Remove item 8 via its grid ✕ button (selectedPlayers order [7, 8] →
		// second ✕). The grid shrinks to one WITHOUT remounting item 7, so the
		// bump must come from the re-cap effect's rise detection, not onReady.
		fireEvent.mouseUp(screen.getAllByText("✕")[1]);

		expect(api.autoLevelCapping).toBe(2); // ceiling: grid of one = full
		expect(api.bandwidthEstimate).toBe(5_000_000); // optimistic reset
		expect(api.nextLevel).toBe(2); // forced switch (flushes low-res buffer)
		handlers.hlsLevelSwitched[0]();
		expect(api.nextLevel).toBe(-1); // auto restored — a nudge, not a pin
	});

	it("probes one level up from the 15s health check when parked below the ceiling", () => {
		vi.useFakeTimers();
		captured.props.length = 0;
		render(<TV />);
		const p = captured.props[captured.props.length - 1];
		const { el, api } = fakeHlsElement();
		(p.onMediaElement as (el: unknown) => void)(el);
		// Deliberately no onReady: the player sits parked at loadLevel 0 with a
		// healthy buffer (fakeHlsElement buffers to t=4000) — the stuck case.

		act(() => {
			vi.advanceTimersByTime(15_000);
		});

		expect(api.nextLoadLevel).toBe(1); // one-fragment probe toward the ceiling
		expect(api.nextLevel).toBe(-1); // still fully in auto mode — no flush
	});
});
