import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
		expect(queryByText("Wave")).toBeNull();
		rerender(<StationPlayer {...base} showWaveform={true} />);
		expect(queryByText("Wave")).not.toBeNull();
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

	// Safari ignores el.volume once the visualizer's createMediaElementSource
	// captures an element (and always on iOS), so muting must also drive
	// el.muted — but only after the element's autoplay unlock, since pre-play
	// elements stay muted so play() is permitted.

	/** Fire canplay and flush the play().then microtask (the autoplay unlock). */
	async function unlock(audio: HTMLAudioElement) {
		fireEvent(audio, new Event("canplay"));
		await act(async () => {});
	}

	it("mutes a playing element via el.muted, not just volume", async () => {
		const { container, rerender } = render(<StationPlayer {...base} />);
		const audio = container.querySelector('audio[src="a.mp3"]') as HTMLAudioElement;
		await unlock(audio);
		expect(audio.muted).toBe(false);
		rerender(<StationPlayer {...base} mutedItems={[1]} />);
		expect(audio.muted).toBe(true);
		expect(audio.volume).toBe(0);
	});

	it("unmuting a playing element restores el.muted = false", async () => {
		const { container, rerender } = render(<StationPlayer {...base} mutedItems={[1]} />);
		const audio = container.querySelector('audio[src="a.mp3"]') as HTMLAudioElement;
		await unlock(audio);
		expect(audio.muted).toBe(true); // canplay while muted keeps it silent
		rerender(<StationPlayer {...base} mutedItems={[]} />);
		expect(audio.muted).toBe(false);
		expect(audio.volume).toBe(1);
	});

	it("never unmutes an element still waiting for its autoplay unlock", () => {
		const { rerender, container } = render(<StationPlayer {...base} mutedItems={[2]} />);
		const audio = container.querySelector('audio[src="a.mp3"]') as HTMLAudioElement;
		expect(audio.muted).toBe(true); // pre-play autoplay mute
		rerender(<StationPlayer {...base} mutedItems={[]} />);
		expect(audio.muted).toBe(true); // mute-state change must not unlock it
	});

	it("onCanPlay honors the current mute list instead of unconditionally unmuting", async () => {
		const { container } = render(<StationPlayer {...base} mutedItems={[1]} />);
		const audio = container.querySelector('audio[src="a.mp3"]') as HTMLAudioElement;
		await unlock(audio);
		expect(audio.muted).toBe(true);
		expect(audio.volume).toBe(0);
	});
});
