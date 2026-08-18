import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stand in for classicy's subtitle hook so the panel's cue lookup is exercised
// without fetching or parsing a real VTT — the same substitution
// radio-core/CaptionOverlay.test.tsx makes. `seen` records the URL the panel
// asked for, which is what pins that it reuses vttUrl() rather than handing the
// parser the .srt (or re-parsing cues itself).
const { seen, CUES } = vi.hoisted(() => ({
	seen: { url: undefined as string | undefined, calls: 0 },
	CUES: [
		{ from: 0, to: 4, text: "Boston Center, American 11" },
		{ from: 6, to: 9, text: "American 11, Boston Center, go ahead" },
	],
}));

vi.mock("classicy", () => ({
	useQuickTimeSubtitles: (url?: string) => {
		seen.url = url;
		seen.calls += 1;
		return {
			activeCueText: (t: number) =>
				url ? (CUES.find((c) => c.from <= t && t < c.to)?.text ?? null) : null,
		};
	},
	registerApp: () => {},
}));

import { makeItem, makeMeta } from "./cardTabFixtures";
import { TranscriptTab } from "./TranscriptTab";

afterEach(() => {
	cleanup();
	seen.url = undefined;
	seen.calls = 0;
});

const TZ = -4;

describe("TranscriptTab", () => {
	it("hands classicy's parser the .vtt sibling, not the .srt on the wire", () => {
		render(
			<TranscriptTab
				item={makeItem({ subtitles: "https://files.example/clip.srt" })}
				meta={makeMeta()}
				tzOffsetHours={TZ}
			/>,
		);
		expect(seen.url).toBe("https://files.example/clip.vtt");
	});

	it("renders the cue covering the playback position", () => {
		const { getByText } = render(
			<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={1} />,
		);
		expect(getByText("Boston Center, American 11")).toBeTruthy();
	});

	it("renders a different cue as playback advances", () => {
		const { getByText } = render(
			<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={7} />,
		);
		expect(getByText("American 11, Boston Center, go ahead")).toBeTruthy();
	});

	it("reads from the top of the clip when no position is supplied", () => {
		const { getByText } = render(<TranscriptTab item={makeItem()} tzOffsetHours={TZ} />);
		expect(getByText("Boston Center, American 11")).toBeTruthy();
	});

	it("marks the gaps between cues rather than collapsing the panel", () => {
		const { container } = render(
			<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={5} />,
		);
		expect(container.querySelector('[data-state="silent"]')).not.toBeNull();
	});

	it("shows a placeholder when the clip has no subtitles", () => {
		const { container, getByText } = render(
			<TranscriptTab
				item={makeItem({ subtitles: undefined })}
				meta={makeMeta()}
				tzOffsetHours={TZ}
				currentTimeSec={1}
			/>,
		);
		expect(container.querySelector('[data-state="none"]')).not.toBeNull();
		expect(getByText(/no transcript/i)).toBeTruthy();
	});

	it("still calls the hook when there are no subtitles, so the order is stable", () => {
		// React forbids a conditional hook; passing undefined through is the
		// only way the panel can flip between having and not having a .vtt
		// without remounting.
		render(
			<TranscriptTab item={makeItem({ subtitles: undefined })} tzOffsetHours={TZ} />,
		);
		expect(seen.calls).toBeGreaterThan(0);
		expect(seen.url).toBeUndefined();
	});

	it("renders for an item with no metadata, the transcript being on the item", () => {
		// All 814 rows have subtitles; the 59 without `parties` still transcribe.
		const { getByText } = render(
			<TranscriptTab item={makeItem()} tzOffsetHours={TZ} currentTimeSec={1} />,
		);
		expect(getByText("Boston Center, American 11")).toBeTruthy();
	});
});
