import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

// react-marquee-text measures element widths to size its clone track; jsdom
// reports zero widths, which crashes its mount effect. The marquee is purely
// presentational here, so render children directly.
vi.mock("react-marquee-text", () => ({
	default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import type React from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { NowPlayingList } from "./NowPlayingList";

function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 0, title: "t", full_title: "t", start_date: "2001-09-11T12:40:00Z",
		url: "u", format: "mp3", approved: 1, mute: 0, volume: 1, jump: 0, trim: 0, ...over,
	};
}

const segs = [
	item({ id: 1, full_title: "ATC Tower" }),
	item({ id: 2, full_title: "", title: "ATC Ground" }),
];

describe("NowPlayingList", () => {
	it("renders one row per segment showing full_title (title fallback)", () => {
		const { getByText, getAllByRole } = render(
			<NowPlayingList segments={segs} mutedItems={[]} onToggleMute={() => {}} />,
		);
		expect(getByText("ATC Tower")).not.toBeNull();
		expect(getByText("ATC Ground")).not.toBeNull(); // full_title empty → title
		expect(getAllByRole("listitem")).toHaveLength(2);
	});

	it("calls onToggleMute with the file id when a row's button is clicked", () => {
		const onToggle = vi.fn();
		const { getAllByRole } = render(
			<NowPlayingList segments={segs} mutedItems={[]} onToggleMute={onToggle} />,
		);
		fireEvent.mouseUp(getAllByRole("button")[0]);
		expect(onToggle).toHaveBeenCalledWith(1);
	});

	it("shows the muted icon (alt 'Unmute') for files in mutedItems", () => {
		const { getAllByRole } = render(
			<NowPlayingList segments={segs} mutedItems={[2]} onToggleMute={() => {}} />,
		);
		const imgs = getAllByRole("img");
		expect(imgs[0].getAttribute("alt")).toBe("Mute"); // id 1 unmuted → action Mute
		expect(imgs[1].getAttribute("alt")).toBe("Unmute"); // id 2 muted → action Unmute
	});

	it("renders a placeholder and no rows when segments is empty", () => {
		const { getByText, queryAllByRole } = render(
			<NowPlayingList segments={[]} mutedItems={[]} onToggleMute={() => {}} />,
		);
		expect(getByText("—")).not.toBeNull();
		expect(queryAllByRole("listitem")).toHaveLength(0);
	});
});
