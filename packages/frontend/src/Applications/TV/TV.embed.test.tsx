import { cleanup, render } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

const captured = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

const FAKE_ITEM = {
	id: 7,
	url: "https://files.example.org/wabc/index.m3u8",
	source: "WABC",
	start_date: "2001-09-11T12:00:00",
	jump: 0,
	subtitles: "https://files.example.org/wabc/subs.srt",
} as unknown as MediaItem;

vi.mock("classicy", async (importOriginal) => {
	const actual = await importOriginal<typeof import("classicy")>();
	const FAKE_STATE = {
		System: {
			Manager: {
				Applications: {
					apps: { "TV.app": { data: {}, open: true, windows: [] } },
				},
			},
		},
	};
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
		useAppManager: (selector: (s: unknown) => unknown) => selector(FAKE_STATE),
		useAppManagerDispatch: () => () => {},
		useClassicyDateTime: () => ({
			dateTime: "2001-09-11T12:40:00.000Z",
			paused: false,
		}),
	};
});

vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({
		items: [FAKE_ITEM],
		sources: { video: ["WABC"], audio: [], pager: [], usenet: [] },
	}),
}));

vi.mock("../../openreplay", () => ({
	trackAppToggle: () => {},
	trackChannelChange: () => {},
}));

import { TV } from "./TV";
import { DEFAULT_CAPTION_STYLE } from "./TVContext";

afterEach(cleanup);

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
});
