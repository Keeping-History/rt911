import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorEntry } from "./editorState";

vi.mock("./resolveTimelineMeta", () => ({
	resolveTimelineMeta: vi.fn(async () => new Map()),
}));

import { barMaskImage, PlaylistTimeline } from "./PlaylistTimeline";
import { resolveTimelineMeta } from "./resolveTimelineMeta";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const entries: EditorEntry[] = [
	{
		uid: "e1",
		entry: {
			kind: "media", app: "tv", itemId: "ABC",
			start: "2001-09-11T12:00:00Z", end: "2001-09-11T13:00:00Z",
		},
	},
	{
		uid: "e2",
		entry: { kind: "media", app: "news", itemId: "42" },
		timelineMeta: { publishedAt: "2001-09-11T12:30:00Z" },
	},
];

describe("PlaylistTimeline", () => {
	it("renders one bar and one flag, and clicking each selects the right uid", () => {
		const onSelect = vi.fn();
		render(<PlaylistTimeline entries={entries} selectedUid={null} onSelect={onSelect} />);

		const bars = document.querySelectorAll(".playlistTimelineBar");
		expect(bars).toHaveLength(1);
		expect(bars[0].getAttribute("title")).toBe("ABC");

		const flags = screen.getAllByRole("button", { name: "⚑" });
		expect(flags).toHaveLength(1);

		fireEvent.click(bars[0]);
		expect(onSelect).toHaveBeenCalledWith("e1");

		fireEvent.click(flags[0]);
		expect(onSelect).toHaveBeenCalledWith("e2");
	});

	it("combines both fade edges into one maskImage on a bar with no start/end", () => {
		// jsdom's CSS parser (cssstyle) silently drops any style value containing
		// calc() inside a gradient (verified: el.style.maskImage reads back "" and
		// the whole style attribute vanishes), so the combined-gradient value is
		// asserted directly against the pure helper the component uses to compute
		// it, rather than via DOM style serialization.
		const combined = barMaskImage(true, true);
		expect(combined).toContain("12px");
		expect(combined).toContain("calc(100% - 12px)");
		expect(combined).toBe(
			"linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)",
		);

		// Wiring check: a bar with only one fade edge (no calc() involved) DOES
		// survive jsdom's style parsing, confirming barMaskImage's output is
		// actually applied to the rendered bar rather than dead code.
		const startOnly: EditorEntry[] = [
			{
				uid: "u1",
				entry: { kind: "media", app: "radio", itemId: "R1", end: "2001-09-11T13:00:00Z" },
			},
		];
		render(<PlaylistTimeline entries={startOnly} selectedUid={null} onSelect={vi.fn()} />);
		const bar = document.querySelector(".playlistTimelineBar") as HTMLElement;
		expect(bar.style.maskImage).toBe(barMaskImage(true, false));
	});

	it("skips the actual-span overlay (and avoids NaN) when a flight's start equals its end", () => {
		const zeroSpan: EditorEntry[] = [
			{
				uid: "f1",
				entry: {
					kind: "media", app: "flights", itemId: "AA11",
					start: "2001-09-11T12:00:00Z", end: "2001-09-11T12:00:00Z",
				},
				timelineMeta: { departure: "2001-09-11T11:59:00Z", arrival: null },
			},
		];
		render(<PlaylistTimeline entries={zeroSpan} selectedUid={null} onSelect={vi.fn()} />);
		expect(document.querySelector(".playlistTimelineActualSpan")).toBeNull();
		for (const el of document.querySelectorAll<HTMLElement>("[style]")) {
			expect(el.getAttribute("style") ?? "").not.toContain("NaN");
		}
	});

	it("does not re-query entries whose meta resolution already ran, but resolves newly-added ones", async () => {
		const mockResolve = vi.mocked(resolveTimelineMeta);
		const entriesV1: EditorEntry[] = [
			{ uid: "r1", entry: { kind: "media", app: "news", itemId: "1" } },
		];
		const { rerender } = render(
			<PlaylistTimeline entries={entriesV1} selectedUid={null} onSelect={vi.fn()} />,
		);
		await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(1));
		expect(mockResolve.mock.calls[0][0]).toEqual(entriesV1);

		// New array identity, exact same entries: should NOT trigger another fetch.
		rerender(<PlaylistTimeline entries={[...entriesV1]} selectedUid={null} onSelect={vi.fn()} />);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockResolve).toHaveBeenCalledTimes(1);

		// A genuinely new, unresolved entry should trigger exactly one more call,
		// scoped to only the new entry.
		const newEntry: EditorEntry = { uid: "r2", entry: { kind: "media", app: "news", itemId: "2" } };
		const entriesV3: EditorEntry[] = [...entriesV1, newEntry];
		rerender(<PlaylistTimeline entries={entriesV3} selectedUid={null} onSelect={vi.fn()} />);
		await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(2));
		expect(mockResolve.mock.calls[1][0]).toEqual([newEntry]);
	});

	it("renders 40 six-hour ruler ticks", () => {
		render(<PlaylistTimeline entries={[]} selectedUid={null} onSelect={vi.fn()} />);
		expect(document.querySelectorAll(".playlistTimelineHourTick")).toHaveLength(40);
	});

	it("widens the track and subdivides the ruler on zoom in, and restores it on zoom out", () => {
		render(<PlaylistTimeline entries={[]} selectedUid={null} onSelect={vi.fn()} />);
		const track = screen.getByTestId("timeline-track");
		const level = screen.getByTestId("timeline-zoom-level");
		expect(track.style.width).toBe("100%");
		expect(level.textContent).toBe("1×");

		fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		expect(track.style.width).toBe("200%");
		expect(level.textContent).toBe("2×");
		expect(document.querySelectorAll(".playlistTimelineHourTick").length).toBeGreaterThan(40);

		fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
		expect(track.style.width).toBe("100%");
		expect(document.querySelectorAll(".playlistTimelineHourTick")).toHaveLength(40);
	});

	it("disables each control at its end of the ladder", () => {
		render(<PlaylistTimeline entries={[]} selectedUid={null} onSelect={vi.fn()} />);
		// jest-dom is not installed here, so assert the DOM property directly
		// rather than reaching for toBeDisabled().
		const zoomIn = screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
		const zoomOut = screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;

		expect(zoomOut.disabled).toBe(true);
		expect(zoomIn.disabled).toBe(false);

		// Walk past the top of the ladder; it must stop, not run past MAX_ZOOM.
		for (let i = 0; i < 12; i += 1) fireEvent.click(zoomIn);
		expect(screen.getByTestId("timeline-zoom-level").textContent).toBe("64×");
		expect(zoomIn.disabled).toBe(true);
		expect(zoomOut.disabled).toBe(false);
	});

	it("un-stacks flags that only collided because they were close as a fraction of ten days", () => {
		// 20 minutes apart: under 1.5% of a ten-day span, so at 1x they stack into
		// separate rows. Zooming in is the whole reason a user reaches for this
		// control, so the stacking threshold has to scale with the track.
		const crowded: EditorEntry[] = [
			{ uid: "n1", entry: { kind: "media", app: "news", itemId: "1" },
				timelineMeta: { publishedAt: "2001-09-11T12:00:00Z" } },
			{ uid: "n2", entry: { kind: "media", app: "news", itemId: "2" },
				timelineMeta: { publishedAt: "2001-09-11T12:20:00Z" } },
		];
		render(<PlaylistTimeline entries={crowded} selectedUid={null} onSelect={vi.fn()} />);

		const topOf = (i: number) =>
			(document.querySelectorAll<HTMLElement>(".playlistTimelineFlag")[i]).style.top;
		expect(topOf(0)).not.toBe(topOf(1));

		for (let i = 0; i < 5; i += 1) {
			fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		}
		expect(topOf(0)).toBe(topOf(1));
	});
});
