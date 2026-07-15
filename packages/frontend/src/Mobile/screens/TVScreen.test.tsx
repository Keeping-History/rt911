import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { ScreenNavContext } from "../WheelContext";
import { TVScreen } from "./TVScreen";

afterEach(cleanup);
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const channel = (id: number, source: string): MediaItem => ({
	id,
	title: source,
	full_title: source,
	source,
	start_date: "2001-09-11T12:30:00",
	url: `https://example.test/${source}.m3u8`,
	format: "m3u8",
	approved: 1,
	mute: 0,
	volume: 1,
	jump: 0,
	trim: 0,
});

describe("TVScreen", () => {
	it("lists channels alphabetically by call sign", () => {
		render(
			<TVScreen
				channels={[channel(2, "WNBC"), channel(1, "WABC")]}
				activeTvId={null}
				onTune={vi.fn()}
				connected
			/>,
		);
		const labels = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(labels[0]).toContain("WABC");
		expect(labels[1]).toContain("WNBC");
	});

	it("tapping a channel tunes it and opens Now Playing", () => {
		const onTune = vi.fn();
		const push = vi.fn();
		render(
			<ScreenNavContext.Provider value={{ push, pop: vi.fn() }}>
				<TVScreen
					channels={[channel(1, "WABC")]}
					activeTvId={null}
					onTune={onTune}
					connected
				/>
			</ScreenNavContext.Provider>,
		);
		fireEvent.click(screen.getByText("WABC"));
		expect(onTune).toHaveBeenCalledWith(1);
		expect(push).toHaveBeenCalledWith("nowPlaying");
	});

	it("marks the channel that is currently playing", () => {
		render(
			<TVScreen
				channels={[channel(1, "WABC"), channel(2, "WNBC")]}
				activeTvId={1}
				onTune={vi.fn()}
				connected
			/>,
		);
		const active = screen
			.getAllByRole("listitem")
			.find((li) => li.textContent?.includes("▶"));
		expect(active?.textContent).toContain("WABC");
	});

	it("shows Connecting… while the stream is down", () => {
		render(
			<TVScreen channels={[]} activeTvId={null} onTune={vi.fn()} connected={false} />,
		);
		expect(screen.getByText("Connecting…")).toBeTruthy();
		expect(screen.queryAllByRole("listitem")).toHaveLength(0);
	});

	it("shows an empty state when no channels are on air", () => {
		render(<TVScreen channels={[]} activeTvId={null} onTune={vi.fn()} connected />);
		expect(screen.getByText("No channels on air.")).toBeTruthy();
	});
});
