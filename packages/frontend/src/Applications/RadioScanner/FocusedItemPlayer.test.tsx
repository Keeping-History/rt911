import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { FocusedItemPlayer } from "./FocusedItemPlayer";

// Probe the CaptionOverlay wiring without exercising the real subtitle hook
// (its own behavior is covered by CaptionOverlay.test.tsx) — capture the props
// FocusedItemPlayer hands it when captions are toggled on.
const captionProps = vi.hoisted(
	() => ({ current: null as Record<string, unknown> | null }),
);
vi.mock("./CaptionOverlay", () => ({
	CaptionOverlay: (props: Record<string, unknown>) => {
		captionProps.current = props;
		return <div data-testid="caption-overlay" />;
	},
}));

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep renders isolated.
afterEach(cleanup);

function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 1, title: "t", full_title: "t", start_date: "2001-09-11T12:40:00Z",
		url: "a.mp3", format: "mp3", approved: 1, mute: 0, volume: 1, jump: 0, trim: 0, ...over,
	};
}

let playSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
	playSpy = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterAll(() => {
	playSpy.mockRestore();
});

describe("FocusedItemPlayer", () => {
	it("renders no waveform control when showWaveform is false, and one when true", () => {
		const { queryByText, rerender } = render(
			<FocusedItemPlayer
				item={item({})}
				onDismiss={() => {}}
				showWaveform={false}
				vizMode="Wave"
				onCycleVizMode={() => {}}
				waveColors={null}
				maxVolume={1}
			/>,
		);
		expect(queryByText("Wave")).toBeNull();
		rerender(
			<FocusedItemPlayer
				item={item({})}
				onDismiss={() => {}}
				showWaveform={true}
				vizMode="Wave"
				onCycleVizMode={() => {}}
				waveColors={null}
				maxVolume={1}
			/>,
		);
		expect(queryByText("Wave")).not.toBeNull();
	});

	it("applies maxVolume to the audio element and tracks changes", () => {
		const { container, rerender } = render(
			<FocusedItemPlayer
				item={item({})}
				onDismiss={() => {}}
				showWaveform={false}
				vizMode="Wave"
				onCycleVizMode={() => {}}
				waveColors={null}
				maxVolume={0.4}
			/>,
		);
		const el = container.querySelector("audio") as HTMLAudioElement;
		expect(el.volume).toBe(0.4);
		rerender(
			<FocusedItemPlayer
				item={item({})}
				onDismiss={() => {}}
				showWaveform={false}
				vizMode="Wave"
				onCycleVizMode={() => {}}
				waveColors={null}
				maxVolume={0.9}
			/>,
		);
		expect(el.volume).toBe(0.9);
	});

	it("does not render the caption overlay when captions are off", () => {
		const { queryByTestId } = render(
			<FocusedItemPlayer
				item={item({ subtitles: "clip.srt" })}
				onDismiss={() => {}}
				showWaveform={false}
				vizMode="Wave"
				onCycleVizMode={() => {}}
				waveColors={null}
				maxVolume={1}
			/>,
		);
		expect(queryByTestId("caption-overlay")).toBeNull();
	});

	it("renders the overlay with the derived .vtt url when captions are on", () => {
		const { getByTestId } = render(
			<FocusedItemPlayer
				item={item({ subtitles: "clip.srt" })}
				onDismiss={() => {}}
				showWaveform={false}
				captionsOn
				vizMode="Wave"
				onCycleVizMode={() => {}}
				waveColors={null}
				maxVolume={1}
			/>,
		);
		expect(getByTestId("caption-overlay")).not.toBeNull();
		const props = captionProps.current as { subtitlesUrl?: string } | null;
		expect(props?.subtitlesUrl).toBe("clip.vtt");
	});
});
