import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanePreview } from "./LanePreview";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const span = { startMs: Date.UTC(2001, 8, 11, 12, 0), endMs: Date.UTC(2001, 8, 11, 12, 30) };

function stubFetchJson(data: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ data }) }) as Response),
	);
}

describe("LanePreview", () => {
	it("renders a thumbnail strip for TV entries", () => {
		render(<LanePreview group="tv" channel="cnn" {...span} viewportPx={400} />);
		// alt="" downgrades <img> to the "presentation" role, dropping it out of
		// getByRole("img") even with { hidden: true } — query by class instead,
		// matching this file's existing convention (jest-dom is not installed).
		const imgs = document.querySelectorAll<HTMLImageElement>(".playlistTimelinePreviewThumb");
		expect(imgs.length).toBeGreaterThan(0);
		expect(imgs[0].src).toContain("files.911realtime.org/thumbnails/cnn/");
	});

	it("renders nothing for a group with no preview", () => {
		const { container } = render(
			<LanePreview group="flights" channel="AA11" {...span} viewportPx={400} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when there is no room", () => {
		const { container } = render(
			<LanePreview group="tv" channel="cnn" {...span} viewportPx={0} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing for radio when nothing aired in the span", () => {
		stubFetchJson([]);
		const { container } = render(
			<LanePreview group="radio" channel="WCBS" {...span} viewportPx={400} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders a non-sticky waveform slot per recording that aired in the span", async () => {
		stubFetchJson([
			{ start_date: "2001-09-11T12:05:00", calc_duration: 60, peaks: [[-5, 5]] },
			// no peaks yet — compute-peaks hasn't reached this row — dropped
			{ start_date: "2001-09-11T12:10:00", calc_duration: 60, peaks: [] },
		]);
		const { container } = render(
			<LanePreview group="radio" channel="WCBS" {...span} viewportPx={400} />,
		);

		await waitFor(() =>
			expect(container.querySelectorAll(".playlistTimelineWaveformSlot")).toHaveLength(1),
		);

		// The non-sticky CSS rule (position: relative) lives in
		// PlaylistEditor.scss and is keyed off this class — jsdom doesn't apply
		// external stylesheets, so this asserts the class is present rather than
		// the computed position.
		const wrapper = container.querySelector(".playlistTimelinePreviewRadio");
		expect(wrapper).not.toBeNull();

		const slot = container.querySelector<HTMLElement>(".playlistTimelineWaveformSlot")!;
		// Recording starts 5min into a 30min span → left = 5/30 ≈ 16.67%.
		expect(slot.style.left).toBe(`${(5 / 30) * 100}%`);
		expect(slot.style.width).toBe(`${(1 / 30) * 100}%`);
		expect(slot.querySelector("canvas")).not.toBeNull();
	});
});
