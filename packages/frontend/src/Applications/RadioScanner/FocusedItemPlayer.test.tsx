import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { FocusedItemPlayer } from "./FocusedItemPlayer";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep renders isolated.
afterEach(cleanup);

function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 1, title: "t", full_title: "t", start_date: "2001-09-11T12:40:00Z",
		url: "a.mp3", format: "mp3", approved: 1, mute: 0, volume: 1, jump: 0, trim: 0, ...over,
	};
}

let playSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
	playSpy = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterAll(() => {
	playSpy.mockRestore();
});

describe("FocusedItemPlayer", () => {
	it("renders no waveform control when showWaveform is false, and one when true", () => {
		const { queryByText, rerender } = render(
			<FocusedItemPlayer item={item({})} onDismiss={() => {}} showWaveform={false} />,
		);
		expect(queryByText("Wave")).toBeNull();
		rerender(<FocusedItemPlayer item={item({})} onDismiss={() => {}} showWaveform={true} />);
		expect(queryByText("Wave")).not.toBeNull();
	});
});
