import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptionOverlay } from "./CaptionOverlay";
import { DEFAULT_CAPTION_STYLE } from "./radioScannerSettings";

// Replace classicy with just the subtitle hook — the fake returns a cue only
// once playback passes 1s, so the tests exercise the currentTime → cue mapping
// without fetching or parsing a real VTT. (CaptionOverlay imports nothing else
// from classicy, so a full replacement is safe here.)
vi.mock("classicy", () => ({
	useQuickTimeSubtitles: (url?: string) => ({
		activeCueText: (t: number) => (url && t >= 1 ? "Hello world" : null),
	}),
}));

afterEach(cleanup);

/** jsdom leaves media currentTime read-only; override it so we can drive time. */
function makeAudio(currentTime: number): HTMLAudioElement {
	const el = document.createElement("audio");
	Object.defineProperty(el, "currentTime", {
		value: currentTime,
		writable: true,
		configurable: true,
	});
	return el;
}

describe("CaptionOverlay", () => {
	it("shows the active cue once playback reaches it", () => {
		render(
			<CaptionOverlay audioEl={makeAudio(2)} subtitlesUrl="clip.vtt" captionStyle={DEFAULT_CAPTION_STYLE} />,
		);
		expect(screen.getByText("Hello world")).toBeTruthy();
	});

	it("renders nothing before any cue is active", () => {
		render(
			<CaptionOverlay audioEl={makeAudio(0)} subtitlesUrl="clip.vtt" captionStyle={DEFAULT_CAPTION_STYLE} />,
		);
		expect(screen.queryByText("Hello world")).toBeNull();
	});

	it("renders nothing when the segment has no subtitles", () => {
		render(<CaptionOverlay audioEl={makeAudio(2)} subtitlesUrl={undefined} captionStyle={DEFAULT_CAPTION_STYLE} />);
		expect(screen.queryByText("Hello world")).toBeNull();
	});

	it("renders nothing when the audio element is not ready", () => {
		render(<CaptionOverlay audioEl={null} subtitlesUrl="clip.vtt" captionStyle={DEFAULT_CAPTION_STYLE} />);
		expect(screen.queryByText("Hello world")).toBeNull();
	});

	it("updates the caption as playback advances (timeupdate)", () => {
		const el = makeAudio(0);
		render(<CaptionOverlay audioEl={el} subtitlesUrl="clip.vtt" captionStyle={DEFAULT_CAPTION_STYLE} />);
		expect(screen.queryByText("Hello world")).toBeNull();

		(el as unknown as { currentTime: number }).currentTime = 2;
		fireEvent(el, new Event("timeupdate"));
		expect(screen.getByText("Hello world")).toBeTruthy();
	});
});
