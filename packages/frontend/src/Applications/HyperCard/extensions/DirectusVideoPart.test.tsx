import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture every QuickTimeVideoEmbed render's props so tests can inspect what the
// part passed and drive the onMediaElement segment hook.
const embedProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("classicy", () => ({
	QuickTimeVideoEmbed: (props: Record<string, unknown>) => {
		embedProps.push(props);
		return (
			<div
				data-testid="qt-embed"
				data-url={String(props.url ?? "")}
				data-hide={String(props.hideControls ?? false)}
				data-muted={String(props.muted ?? false)}
				data-caps={String(props.captionsEnabled ?? false)}
				data-subs={String(props.subtitlesUrl ?? "")}
			/>
		);
	},
	timeFriendly: (s: number) => `t${Math.floor(s)}`,
}));

import { DirectusVideo, DirectusVideoPart } from "./DirectusVideoPart";
import { DirectusMultiviewPart } from "./DirectusMultiviewPart";
import { readVideoOptions } from "./videoOptions";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	embedProps.length = 0;
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return { ok, status, json: async () => body } as unknown as Response;
}

/** A minimal HTMLVideoElement stand-in that records listeners and can emit. */
function makeFakeVideo() {
	const listeners: Record<string, Array<() => void>> = {};
	return {
		currentTime: 0,
		readyState: 1,
		paused: false,
		poster: "",
		play: vi.fn(() => Promise.resolve()),
		pause: vi.fn(function (this: { paused: boolean }) {
			this.paused = true;
		}),
		addEventListener: (t: string, f: () => void) => {
			(listeners[t] ||= []).push(f);
		},
		removeEventListener: (t: string, f: () => void) => {
			listeners[t] = (listeners[t] || []).filter((x) => x !== f);
		},
		emit: (t: string) => (listeners[t] || []).forEach((f) => f()),
	};
}

const lastEmbed = () => embedProps[embedProps.length - 1];

describe("readVideoOptions", () => {
	it("defaults controls on, reads channelId (and itemId alias)", () => {
		expect(readVideoOptions({}).controls).toBe(true);
		expect(readVideoOptions({ controls: false }).controls).toBe(false);
		expect(readVideoOptions({ channelId: 5 }).channelId).toBe(5);
		expect(readVideoOptions({ itemId: 7 }).channelId).toBe(7);
	});
});

describe("DirectusVideoPart", () => {
	it("shows 'No video source' with no url or channelId", () => {
		render(<DirectusVideoPart {...partProps({})} />);
		expect(screen.getByText("No video source")).toBeTruthy();
	});

	it("plays a direct url and hides controls when controls:false", () => {
		render(<DirectusVideoPart {...partProps({ url: "https://x/a.m3u8", controls: false })} />);
		const el = screen.getByTestId("qt-embed");
		expect(el.getAttribute("data-url")).toBe("https://x/a.m3u8");
		expect(el.getAttribute("data-hide")).toBe("true");
	});

	it("mutes by default when autoplaying", () => {
		render(<DirectusVideoPart {...partProps({ url: "https://x/a.m3u8", autoPlay: true })} />);
		expect(screen.getByTestId("qt-embed").getAttribute("data-muted")).toBe("true");
	});

	it("enables captions by default when captions:true", () => {
		render(<DirectusVideoPart {...partProps({ url: "https://x/a.m3u8", captions: true })} />);
		expect(screen.getByTestId("qt-embed").getAttribute("data-caps")).toBe("true");
	});

	it("fetches a channel and passes its url and derived vtt subtitles", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: {
					id: 3,
					title: "WNYW",
					full_title: "WNYW Fox 5",
					url: "https://x/ch3.m3u8",
					start_date: "2001-09-11T12:40:00",
					subtitles: "https://x/ch3.srt",
				},
			}),
		);
		render(<DirectusVideoPart {...partProps({ channelId: 3 })} />);
		const el = await screen.findByTestId("qt-embed");
		expect(el.getAttribute("data-url")).toBe("https://x/ch3.m3u8");
		expect(el.getAttribute("data-subs")).toBe("https://x/ch3.vtt");
	});

	it("shows an error note when the fetch fails", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, false, 500));
		render(<DirectusVideoPart {...partProps({ channelId: 1 })} />);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/Could not load video/)).toBeTruthy();
	});
});

describe("DirectusVideo segment enforcement", () => {
	it("seeks to the start offset once the element is ready", () => {
		render(<DirectusVideo appId="t" url="https://x/a.m3u8" start={10} end={20} />);
		const video = makeFakeVideo();
		act(() => {
			(lastEmbed().onMediaElement as (el: unknown) => void)(video);
		});
		expect(video.currentTime).toBe(10);
	});

	it("pauses and fires onSegmentEnd at the end bound (no loop)", () => {
		const onEnd = vi.fn();
		render(<DirectusVideo appId="t" url="https://x/a.m3u8" start={10} end={20} onSegmentEnd={onEnd} />);
		const video = makeFakeVideo();
		act(() => {
			(lastEmbed().onMediaElement as (el: unknown) => void)(video);
		});
		act(() => {
			video.currentTime = 20.1;
			video.emit("timeupdate");
		});
		expect(video.pause).toHaveBeenCalled();
		expect(onEnd).toHaveBeenCalledTimes(1);
	});

	it("loops back to the start at the end bound when loop:true", () => {
		render(<DirectusVideo appId="t" url="https://x/a.m3u8" start={10} end={20} loop />);
		const video = makeFakeVideo();
		act(() => {
			(lastEmbed().onMediaElement as (el: unknown) => void)(video);
		});
		act(() => {
			video.currentTime = 20.1;
			video.emit("timeupdate");
		});
		expect(video.currentTime).toBe(10);
		expect(video.play).toHaveBeenCalled();
	});
});

describe("DirectusMultiviewPart", () => {
	it("renders one tile per video and solos the active tile's audio", () => {
		render(
			<DirectusMultiviewPart
				{...partProps({
					audio: "solo",
					columns: 2,
					videos: [{ url: "https://x/1.m3u8" }, { url: "https://x/2.m3u8" }, { url: "https://x/3.m3u8" }],
				})}
			/>,
		);
		expect(screen.getAllByTestId("qt-embed")).toHaveLength(3);
		// solo mode: exactly one tile unmuted (the active one).
		const unmuted = embedProps.filter((p) => p.muted === false);
		expect(unmuted).toHaveLength(1);
	});

	it("mutes every tile in 'mute' mode", () => {
		render(
			<DirectusMultiviewPart
				{...partProps({ audio: "mute", videos: [{ url: "https://x/1.m3u8" }, { url: "https://x/2.m3u8" }] })}
			/>,
		);
		expect(embedProps.every((p) => p.muted === true)).toBe(true);
	});

	it("shows a message when no videos are configured", () => {
		render(<DirectusMultiviewPart {...partProps({ videos: [] })} />);
		expect(screen.getByText("No videos configured")).toBeTruthy();
	});
});

// Build HyperCardPartProps with the given options and sensible defaults.
function partProps(options: Record<string, unknown>) {
	return {
		part: { id: "p", type: "directusVideo" },
		partId: "p",
		stackId: "s",
		options,
		locked: false,
		value: "",
		setValue: vi.fn(),
		fire: vi.fn(),
		getVariable: vi.fn(),
		resolve: (e: string) => e,
	} as unknown as Parameters<typeof DirectusVideoPart>[0];
}
