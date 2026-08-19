import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeItem, makeMeta } from "./cardTabFixtures";
import { TranscriptTab } from "./TranscriptTab";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const TZ = -4;

/** The shape the CDN really serves — first cue at 0.800, not at zero. */
const VTT = `WEBVTT

00:00:00.800 --> 00:00:04.000
Boston Center, American 11.

00:00:06.000 --> 00:00:09.000
American 11, Boston Center, go ahead.
`;

/**
 * Stub `fetch` rather than classicy's hook.
 *
 * The panel parses the VTT itself now, because classicy exposes only
 * `activeCueText(seconds)` and never its cue list — so there is no hook seam
 * left to substitute, and mocking one would test nothing. This stub is the
 * network boundary; everything above it is the real parser.
 */
function stubFetch(body: string, init: { ok?: boolean; status?: number } = {}) {
	const fetchMock = vi.fn(async (_url: string) => ({
		ok: init.ok ?? true,
		status: init.status ?? 200,
		text: async () => body,
	}));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("TranscriptTab", () => {
	beforeEach(() => {
		stubFetch(VTT);
	});

	it("fetches the .vtt sibling, not the .srt the wire carries", async () => {
		const fetchMock = stubFetch(VTT);
		render(
			<TranscriptTab
				item={makeItem({ subtitles: "https://files.example/clip.srt" })}
				meta={makeMeta()}
				tzOffsetHours={TZ}
			/>,
		);
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(fetchMock.mock.calls[0][0]).toBe("https://files.example/clip.vtt");
	});

	it("shows the whole transcript for a card that is not playing", async () => {
		// The case that was broken: no currentTimeSec at all, which is every
		// UPCOMING card, every unstarted PREVIOUS card, and every LIVE card until
		// its audio element loads.
		render(<TranscriptTab item={makeItem()} tzOffsetHours={TZ} />);
		expect(await screen.findByText("Boston Center, American 11.")).toBeTruthy();
		expect(screen.getByText("American 11, Boston Center, go ahead.")).toBeTruthy();
	});

	it("shows the whole transcript while playing, not only the active cue", async () => {
		render(<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={7} />);
		expect(await screen.findByText("Boston Center, American 11.")).toBeTruthy();
		expect(screen.getByText("American 11, Boston Center, go ahead.")).toBeTruthy();
	});

	it("marks the cue under the playhead, and only that one", async () => {
		const { container } = render(
			<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={7} />,
		);
		await screen.findByText("American 11, Boston Center, go ahead.");
		const active = container.querySelectorAll('[data-active="true"]');
		expect(active).toHaveLength(1);
		expect(active[0].textContent).toBe("American 11, Boston Center, go ahead.");
	});

	it("moves the mark as playback advances", async () => {
		const { container } = render(
			<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={1} />,
		);
		await screen.findByText("Boston Center, American 11.");
		expect(container.querySelector('[data-active="true"]')?.textContent).toBe(
			"Boston Center, American 11.",
		);
	});

	it("marks nothing between cues, but still shows the transcript", async () => {
		// 5s is in the gap between the two cues. The old panel collapsed to an em
		// dash here; the words are what the reader came for.
		const { container } = render(
			<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={5} />,
		);
		await screen.findByText("Boston Center, American 11.");
		expect(container.querySelector('[data-active="true"]')).toBeNull();
	});

	it("marks nothing when the card has no playhead", async () => {
		const { container } = render(<TranscriptTab item={makeItem()} tzOffsetHours={TZ} />);
		await screen.findByText("Boston Center, American 11.");
		expect(container.querySelector('[data-active="true"]')).toBeNull();
	});

	it("shows a placeholder, and never fetches, when the clip has no subtitles", async () => {
		const fetchMock = stubFetch(VTT);
		const { container } = render(
			<TranscriptTab
				item={makeItem({ subtitles: undefined })}
				meta={makeMeta()}
				tzOffsetHours={TZ}
				currentTimeSec={1}
			/>,
		);
		expect(container.querySelector('[data-state="none"]')).not.toBeNull();
		expect(screen.getByText(/no transcript/i)).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("says so when the transcript cannot be fetched", async () => {
		// A 404 on the .vtt must read as a failure, not as a clip that said
		// nothing — the two are very different facts about the archive.
		stubFetch("Not Found", { ok: false, status: 404 });
		const { container } = render(<TranscriptTab item={makeItem()} tzOffsetHours={TZ} />);
		await waitFor(() =>
			expect(container.querySelector('[data-state="error"]')).not.toBeNull(),
		);
		expect(screen.getByText(/unavailable/i)).toBeTruthy();
	});

	it("says so when the file parses to no cues at all", async () => {
		stubFetch("WEBVTT\n\n");
		const { container } = render(<TranscriptTab item={makeItem()} tzOffsetHours={TZ} />);
		await waitFor(() =>
			expect(container.querySelector('[data-state="empty"]')).not.toBeNull(),
		);
	});

	it("renders for an item with no metadata, the transcript being on the item", async () => {
		// All 814 rows have subtitles; the 59 without `parties` still transcribe.
		render(<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={1} />);
		expect(await screen.findByText("Boston Center, American 11.")).toBeTruthy();
	});
});
