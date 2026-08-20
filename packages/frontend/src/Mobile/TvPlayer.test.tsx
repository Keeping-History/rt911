// packages/frontend/src/Mobile/TvPlayer.test.tsx
// Unit tests via a captured QuickTimeVideoEmbed stub (the partial classicy
// mock pattern — never a full module replacement) and a plain-object stand-in
// for the <hls-video> element, since jsdom's media elements lack play().
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../Providers/MediaStream/MediaStreamContext";

const captured: { props: Record<string, unknown>[] } = { props: [] };

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	QuickTimeVideoEmbed: (props: Record<string, unknown>) => {
		captured.props.push(props);
		return <div data-testid="qt-embed" />;
	},
}));

import { MOBILE_TV_LEVEL, TvPlayer } from "./TvPlayer";

afterEach(cleanup);
beforeEach(() => {
	captured.props = [];
});

const NOW = Date.parse("2001-09-11T12:40:00.000Z");
const ITEM: MediaItem = {
	id: 42,
	title: "WABC",
	full_title: "WABC 7 New York",
	source: "WABC",
	start_date: "2001-09-11T12:30:00",
	url: "https://example.test/wabc.m3u8",
	format: "m3u8",
	approved: 1,
	mute: 0,
	volume: 1,
	jump: 0,
	trim: 0,
};

/** Plain-object stand-in for the <hls-video> element (jsdom lacks play()). */
function fakeVideoEl() {
	return {
		currentTime: 0,
		paused: false,
		ended: false,
		play: vi.fn(() => Promise.resolve()),
		buffered: { length: 0, start: () => 0, end: () => 0 },
		api: {
			autoLevelCapping: -1,
			autoLevelEnabled: true,
			bandwidthEstimate: 0,
			currentLevel: 0,
			loadLevel: MOBILE_TV_LEVEL,
			nextLevel: -1,
			nextLoadLevel: 0,
			once: vi.fn(),
		},
	} as unknown as HTMLVideoElement;
}

const lastProps = () => captured.props[captured.props.length - 1];

const renderPlayer = (over: Partial<Parameters<typeof TvPlayer>[0]> = {}) =>
	render(
		<TvPlayer
			item={ITEM}
			visible
			nowMs={NOW}
			getNowMs={() => NOW}
			clockPaused={false}
			{...over}
		/>,
	);

describe("TvPlayer", () => {
	it("starts playback at the virtual-clock position, capped at the mid tier", () => {
		renderPlayer();
		const options = lastProps().options as { hls: Record<string, unknown> };
		// 12:40:00 clock − 12:30:00 start = 600 s into the file.
		expect(options.hls.startPosition).toBe(600);
		expect(options.hls.startLevel).toBe(MOBILE_TV_LEVEL);
		expect(lastProps().playing).toBe(true);
		expect(lastProps().playsInline).toBe(true);
	});

	it("onReady seeks the element to the clock and caps ABR at the mid tier", () => {
		renderPlayer();
		const el = fakeVideoEl();
		(lastProps().onMediaElement as (el: HTMLVideoElement) => void)(el);
		(lastProps().onReady as () => void)();
		expect(el.currentTime).toBe(600);
		expect(
			(el as unknown as { api: { autoLevelCapping: number } }).api.autoLevelCapping,
		).toBe(MOBILE_TV_LEVEL);
	});

	it("hides the picture without unmounting when visible flips off", () => {
		const { rerender } = renderPlayer();
		rerender(
			<TvPlayer
				item={ITEM}
				visible={false}
				nowMs={NOW}
				getNowMs={() => NOW}
				clockPaused={false}
			/>,
		);
		expect(screen.getByTestId("qt-embed")).toBeTruthy(); // still mounted
		expect(document.querySelector(".ipodTvPlayerHidden")).toBeTruthy();
	});

	it("re-seeks immediately when the virtual clock jumps (Time Travel)", () => {
		const { rerender } = renderPlayer();
		const el = fakeVideoEl();
		(lastProps().onMediaElement as (el: HTMLVideoElement) => void)(el);
		const JUMPED = NOW + 3_600_000; // +1 h — far past a natural 1 s tick
		rerender(
			<TvPlayer
				item={ITEM}
				visible
				nowMs={JUMPED}
				getNowMs={() => JUMPED}
				clockPaused={false}
			/>,
		);
		expect(el.currentTime).toBe(600 + 3600);
	});

	it("pauses playback with the virtual clock and pins the freeze frame", () => {
		const { rerender } = renderPlayer();
		const el = fakeVideoEl();
		(lastProps().onMediaElement as (el: HTMLVideoElement) => void)(el);
		rerender(
			<TvPlayer
				item={ITEM}
				visible
				nowMs={NOW}
				getNowMs={() => NOW}
				clockPaused
			/>,
		);
		expect(lastProps().playing).toBe(false);
		expect(el.currentTime).toBe(600); // freeze frame pinned to the clock
	});
});
