import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueue } from "../../lib/directusQueue";
import { LanePreview } from "./LanePreview";
import { FULL_BOUNDS } from "./timelineLayout";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** The entry's own committed window: half an hour on 11 September. */
const ENTRY_START = Date.UTC(2001, 8, 11, 12, 0);
const ENTRY_END = Date.UTC(2001, 8, 11, 12, 30);

/**
 * A viewport showing only that half hour of the ten-day track — i.e. deeply
 * zoomed in, which is where a slot laid out against the VISIBLE span instead of
 * the track lands somewhere else entirely.
 */
const props = {
	visibleStartMs: ENTRY_START,
	visibleEndMs: ENTRY_END,
	viewportPx: 400,
	entryStartMs: ENTRY_START,
	entryEndMs: ENTRY_END,
	bounds: FULL_BOUNDS,
};

const TRACK_MS = FULL_BOUNDS.endMs - FULL_BOUNDS.startMs;

function stubFetchJson(data: unknown) {
	const spy = vi.fn(async () => ({ ok: true, json: async () => ({ data }) }) as Response);
	vi.stubGlobal("fetch", spy);
	return spy;
}

/**
 * Let every queued Directus call settle and its state update flush.
 * `directusGet` serializes on a module-global promise chain, so enqueuing a
 * no-op behind the pending request is a deterministic "everything before me has
 * finished" — no timers, no arbitrary microtask counting.
 */
async function drainDirectusQueue() {
	await act(async () => {
		await enqueue(async () => undefined);
	});
}

describe("LanePreview", () => {
	it("renders a thumbnail strip for TV entries", () => {
		render(<LanePreview group="tv" channel="cnn" {...props} />);
		// alt="" downgrades <img> to the "presentation" role, dropping it out of
		// getByRole("img") even with { hidden: true } — query by class instead,
		// matching this file's existing convention (jest-dom is not installed).
		const imgs = document.querySelectorAll<HTMLImageElement>(".playlistTimelinePreviewThumb");
		expect(imgs.length).toBeGreaterThan(0);
		expect(imgs[0].src).toContain("files.911realtime.org/thumbnails/cnn/");
	});

	it("renders nothing for a group with no preview", () => {
		const { container } = render(<LanePreview group="flights" channel="AA11" {...props} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when there is no room", () => {
		const { container } = render(<LanePreview group="tv" channel="cnn" {...props} viewportPx={0} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing for radio when nothing aired in the entry's window", async () => {
		const spy = stubFetchJson([]);
		const { container } = render(<LanePreview group="radio" channel="WCBS" {...props} />);

		// Asserting straight after render would pass no matter what the stub
		// returned — no state update from the fetch can have flushed yet. The
		// assertion is only worth anything once the request has SETTLED.
		await waitFor(() => expect(spy).toHaveBeenCalled());
		await drainDirectusQueue();

		expect(container.querySelector(".playlistTimelinePreviewRadio")).toBeNull();
		expect(container.querySelector(".playlistTimelineWaveformSlot")).toBeNull();
		expect(container.firstChild).toBeNull();
	});

	it("positions each waveform slot against the timeline bounds, not the visible span", async () => {
		stubFetchJson([
			{ id: 11, start_date: "2001-09-11T12:05:00", calc_duration: 60, peaks: [[-5, 5]] },
			// no peaks yet — compute-peaks hasn't reached this row — dropped
			{ id: 12, start_date: "2001-09-11T12:10:00", calc_duration: 60, peaks: [] },
		]);
		const { container } = render(<LanePreview group="radio" channel="WCBS" {...props} />);

		await waitFor(() =>
			expect(container.querySelectorAll(".playlistTimelineWaveformSlot")).toHaveLength(1),
		);

		// The non-sticky CSS rule (position: relative) lives in
		// PlaylistEditor.scss and is keyed off this class — jsdom doesn't apply
		// external stylesheets, so this asserts the class is present rather than
		// the computed position.
		expect(container.querySelector(".playlistTimelinePreviewRadio")).not.toBeNull();

		const slot = container.querySelector<HTMLElement>(".playlistTimelineWaveformSlot")!;
		// The containing block is the lane, which spans the WHOLE zoomed track —
		// so a percentage here is a fraction of the ten-day bounds, worked out
		// from first principles rather than from the layout helper under test.
		const recordingStart = Date.UTC(2001, 8, 11, 12, 5);
		const expectedLeft = ((recordingStart - FULL_BOUNDS.startMs) / TRACK_MS) * 100;
		const expectedWidth = (60_000 / TRACK_MS) * 100;
		expect(parseFloat(slot.style.left)).toBeCloseTo(expectedLeft, 6);
		expect(parseFloat(slot.style.width)).toBeCloseTo(expectedWidth, 6);

		// …and emphatically NOT the visible-span fractions the strip used to
		// compute (5/30 and 1/30 of the half-hour window), which at this zoom
		// would paint the recording about 1.7 days into the track.
		expect(parseFloat(slot.style.left)).not.toBeCloseTo((5 / 30) * 100, 2);
		expect(parseFloat(slot.style.width)).not.toBeCloseTo((1 / 30) * 100, 2);

		expect(slot.querySelector("canvas")).not.toBeNull();
	});

	it("draws every recording that shares a start time, once each, across a refetch", async () => {
		// `(station, start_date)` is NOT unique in production: 20 collision groups
		// across the corpus, 17 of them with differing durations. `UA93 @
		// 2001-09-11T13:34:00` is three rows (451/452/453) of 26 s, 86 s and 52 s.
		// Keyed on the start instant, the three slots are indistinguishable to
		// React's reconciler.
		const rows = [
			// Ends at 12:01, so it drops out of the window in the second pass
			// below — an edge drag that moves the entry's start past it.
			{ id: 300, start_date: "2001-09-11T12:00:00", calc_duration: 60, peaks: [[-1, 1]] },
			{ id: 451, start_date: "2001-09-11T12:05:00", calc_duration: 26, peaks: [[-5, 5]] },
			{ id: 452, start_date: "2001-09-11T12:05:00", calc_duration: 86, peaks: [[-6, 6]] },
			{ id: 453, start_date: "2001-09-11T12:05:00", calc_duration: 52, peaks: [[-7, 7]] },
		];
		stubFetchJson(rows);
		const { container, rerender } = render(<LanePreview group="radio" channel="UA93" {...props} />);

		// Each slot's width IS its recording's duration (as a fraction of the
		// ten-day track), so distinct durations make a lost or duplicated slot
		// legible rather than hiding behind three identical boxes.
		const slotDurationsSec = () =>
			[...container.querySelectorAll<HTMLElement>(".playlistTimelineWaveformSlot")].map(
				(s) => Math.round((parseFloat(s.style.width) / 100) * TRACK_MS) / 1000,
			);

		await waitFor(() => expect(slotDurationsSec()).toEqual([60, 26, 86, 52]));

		// Commit an edge drag that starts the entry after the 12:00 recording. The
		// refetch returns the same rows; overlappingSpans drops the first. That
		// breaks the reconciler's lockstep at index 0, which is exactly where a
		// non-unique key stops being a warning and starts producing wrong DOM:
		// React cannot match the surviving duplicates to their previous fibers, so
		// the stale ones are neither reused nor deleted and the list ends up
		// [26, 86, 26, 86, 52] — the same audio painted twice.
		rerender(
			<LanePreview
				group="radio"
				channel="UA93"
				{...props}
				entryStartMs={Date.UTC(2001, 8, 11, 12, 3)}
			/>,
		);
		await drainDirectusQueue();
		expect(slotDurationsSec()).toEqual([26, 86, 52]);
	});

	it("does not refetch when the visible span moves under an unchanged entry", async () => {
		const spy = stubFetchJson([
			{ id: 11, start_date: "2001-09-11T12:05:00", calc_duration: 60, peaks: [[-5, 5]] },
		]);
		const { container, rerender } = render(<LanePreview group="radio" channel="WCBS" {...props} />);
		await waitFor(() =>
			expect(container.querySelectorAll(".playlistTimelineWaveformSlot")).toHaveLength(1),
		);
		expect(spy).toHaveBeenCalledTimes(1);

		// A pan: the scroll viewport now covers a different stretch of track, but
		// the SELECTED ENTRY has not changed. Before the fix this was the fetch
		// key, so a three-second pan fired ~60 unabortable Directus requests.
		for (const shift of [60_000, 120_000, 180_000]) {
			rerender(
				<LanePreview
					group="radio"
					channel="WCBS"
					{...props}
					visibleStartMs={ENTRY_START + shift}
					visibleEndMs={ENTRY_END + shift}
					viewportPx={400 + shift / 60_000}
				/>,
			);
		}
		await drainDirectusQueue();
		expect(spy).toHaveBeenCalledTimes(1);

		// Control: the entry's own window IS a fetch key, so committing an edge
		// drag still refetches — proving the assertion above can fail.
		rerender(
			<LanePreview group="radio" channel="WCBS" {...props} entryEndMs={ENTRY_END + 600_000} />,
		);
		await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
	});
});
