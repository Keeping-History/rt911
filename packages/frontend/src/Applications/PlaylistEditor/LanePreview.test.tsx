import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanePreview } from "./LanePreview";

afterEach(cleanup);

const span = { startMs: Date.UTC(2001, 8, 11, 12, 0), endMs: Date.UTC(2001, 8, 11, 12, 30) };

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
			<LanePreview group="radio" channel="wcbs" {...span} viewportPx={400} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when there is no room", () => {
		const { container } = render(
			<LanePreview group="tv" channel="cnn" {...span} viewportPx={0} />,
		);
		expect(container.firstChild).toBeNull();
	});
});
