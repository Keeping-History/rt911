import { render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { StationPlayer } from "./StationPlayer";
import type { Station } from "./stationGrouping";

function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 0, title: "t", full_title: "t", start_date: "2001-09-11T12:40:00Z",
		url: "u", format: "mp3", approved: 1, mute: 0, volume: 1, jump: 0, trim: 0, ...over,
	};
}
const t = (s: string) => new Date(s).getTime();

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
	playSpy = vi
		.spyOn(window.HTMLMediaElement.prototype, "play")
		.mockResolvedValue(undefined);
	pauseSpy = vi
		.spyOn(window.HTMLMediaElement.prototype, "pause")
		.mockImplementation(() => {});
});
afterAll(() => {
	playSpy.mockRestore();
	pauseSpy.mockRestore();
});

const station: Station = {
	key: "ATC",
	label: "ATC",
	items: [
		item({ id: 1, url: "a.mp3", start_date: "2001-09-11T12:40:00Z", end_date: "2001-09-11T12:50:00Z" }),
		item({ id: 2, url: "b.mp3", start_date: "2001-09-11T12:45:00Z", end_date: "2001-09-11T12:55:00Z" }),
		item({ id: 3, url: "c.mp3", start_date: "2001-09-11T13:00:00Z", end_date: "2001-09-11T13:05:00Z" }),
	],
};

describe("StationPlayer", () => {
	it("renders one <audio> per in-window segment with its url (overlap → both)", () => {
		const { container } = render(
			<StationPlayer station={station} nowMs={t("2001-09-11T12:47:00Z")} getNowMs={() => t("2001-09-11T12:47:00Z")} muted={false} clockPaused={false} showWaveform={false} />,
		);
		const audios = Array.from(container.querySelectorAll("audio"));
		expect(audios.map((a) => a.getAttribute("src")).sort()).toEqual(["a.mp3", "b.mp3"]);
	});

	it("renders no <audio> in a gap between segments", () => {
		const { container } = render(
			<StationPlayer station={station} nowMs={t("2001-09-11T12:57:00Z")} getNowMs={() => t("2001-09-11T12:57:00Z")} muted={false} clockPaused={false} showWaveform={false} />,
		);
		expect(container.querySelectorAll("audio")).toHaveLength(0);
	});

	it("renders no waveform control when showWaveform is false, and one when true", () => {
		const props = { station, nowMs: t("2001-09-11T12:47:00Z"), getNowMs: () => t("2001-09-11T12:47:00Z"), muted: false, clockPaused: false };
		const { queryByText, rerender } = render(<StationPlayer {...props} showWaveform={false} />);
		expect(queryByText("Bars")).toBeNull(); // WaveformVisualizer's mode button
		rerender(<StationPlayer {...props} showWaveform={true} />);
		expect(queryByText("Bars")).not.toBeNull();
	});

	it("pauses mounted elements when the clock pauses", () => {
		const props = { station, nowMs: t("2001-09-11T12:47:00Z"), getNowMs: () => t("2001-09-11T12:47:00Z"), muted: false, showWaveform: false };
		const { rerender } = render(<StationPlayer {...props} clockPaused={false} />);
		pauseSpy.mockClear();
		rerender(<StationPlayer {...props} clockPaused={true} />);
		expect(pauseSpy).toHaveBeenCalled();
	});

	it("re-render does not re-mute an element that onCanPlay already unmuted", () => {
		// Verify Fix 1: stable ref callbacks mean React only invokes the ref on
		// real mount/unmount, so a playing (unmuted) element stays unmuted across
		// ordinary re-renders (e.g. clock tick, prop change).
		const nowMs = t("2001-09-11T12:47:00Z");
		const props = { station, nowMs, getNowMs: () => nowMs, muted: false, clockPaused: false, showWaveform: false };
		const { container, rerender } = render(<StationPlayer {...props} />);

		// Grab one of the mounted <audio> elements and simulate onCanPlay unmuting.
		const audio = container.querySelector("audio") as HTMLAudioElement;
		expect(audio).not.toBeNull();
		audio.muted = false; // simulate what onCanPlay does after play() resolves

		// Re-render with the same nowMs (same in-window segments → no unmount).
		rerender(<StationPlayer {...props} />);

		// The element must still be unmuted — the stable ref was NOT re-invoked.
		expect(audio.muted).toBe(false);
	});
});
