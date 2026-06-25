import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { StationPlayer } from "./StationPlayer";
import type { Station } from "./stationGrouping";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep renders isolated.
afterEach(cleanup);

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
	playSpy = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
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
const base = {
	station,
	nowMs: t("2001-09-11T12:47:00Z"),
	getNowMs: () => t("2001-09-11T12:47:00Z"),
	stationMuted: false,
	mutedItems: [] as number[],
	clockPaused: false,
	showWaveform: false,
};

describe("StationPlayer", () => {
	it("renders one <audio> per in-window segment with its url (overlap → both)", () => {
		const { container } = render(<StationPlayer {...base} />);
		const audios = Array.from(container.querySelectorAll("audio"));
		expect(audios.map((a) => a.getAttribute("src")).sort()).toEqual(["a.mp3", "b.mp3"]);
	});

	it("renders no <audio> in a gap between segments", () => {
		const { container } = render(
			<StationPlayer {...base} nowMs={t("2001-09-11T12:57:00Z")} getNowMs={() => t("2001-09-11T12:57:00Z")} />,
		);
		expect(container.querySelectorAll("audio")).toHaveLength(0);
	});

	it("renders no waveform control when showWaveform is false, and one when true", () => {
		const { queryByText, rerender } = render(<StationPlayer {...base} showWaveform={false} />);
		expect(queryByText("Bars")).toBeNull();
		rerender(<StationPlayer {...base} showWaveform={true} />);
		expect(queryByText("Bars")).not.toBeNull();
	});

	it("pauses mounted elements when the clock pauses", () => {
		const { rerender } = render(<StationPlayer {...base} clockPaused={false} />);
		pauseSpy.mockClear();
		rerender(<StationPlayer {...base} clockPaused={true} />);
		expect(pauseSpy).toHaveBeenCalled();
	});

	it("re-render does not re-mute an element that onCanPlay already unmuted", () => {
		const { container, rerender } = render(<StationPlayer {...base} />);
		const audio = container.querySelector("audio") as HTMLAudioElement;
		expect(audio).not.toBeNull();
		audio.muted = false; // simulate onCanPlay unmute
		rerender(<StationPlayer {...base} />);
		expect(audio.muted).toBe(false);
	});

	it("sets volume 0 for files in mutedItems and 1 for others", () => {
		const { container } = render(<StationPlayer {...base} mutedItems={[1]} />);
		const audios = Array.from(container.querySelectorAll("audio")) as HTMLAudioElement[];
		const bySrc = new Map(audios.map((a) => [a.getAttribute("src"), a.volume]));
		expect(bySrc.get("a.mp3")).toBe(0); // id 1 muted
		expect(bySrc.get("b.mp3")).toBe(1); // id 2 not muted
	});

	it("sets volume 0 for all files when the station is muted", () => {
		const { container } = render(<StationPlayer {...base} stationMuted={true} />);
		const audios = Array.from(container.querySelectorAll("audio")) as HTMLAudioElement[];
		expect(audios.every((a) => a.volume === 0)).toBe(true);
	});
});
