import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

// react-fast-marquee measures via ResizeObserver, which jsdom doesn't
// implement. The marquee is purely presentational here, so render children
// directly — recording the play prop so tests can assert pause-on-solo.
vi.mock("./marquee", () => ({
	default: ({ children, play }: { children?: React.ReactNode; play?: boolean }) => (
		<div data-testid="marquee" data-play={String(play ?? true)}>
			{children}
		</div>
	),
}));

// jsdom has no layout, so drive the fits/overflows decision from the tests
// instead of from real measurement (the hook has its own unit tests).
const overflow = vi.hoisted(() => ({ value: false }));
vi.mock("./useHorizontalOverflow", () => ({
	useHorizontalOverflow: () => ({
		containerRef: () => {},
		contentRef: () => {},
		overflowing: overflow.value,
	}),
}));
beforeEach(() => {
	overflow.value = true; // most tests exercise the scrolling (marquee) mode
});

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

const noop = () => {};

function renderList(over: Partial<React.ComponentProps<typeof NowPlayingList>> = {}) {
	return render(
		<NowPlayingList
			segments={segs}
			mutedItems={[]}
			onToggleMute={noop}
			soloItemId={null}
			onToggleSolo={noop}
			{...over}
		/>,
	);
}

describe("NowPlayingList", () => {
	it("renders one row per segment showing full_title (title fallback)", () => {
		const { getByText, getAllByRole } = renderList();
		expect(getByText("ATC Tower")).not.toBeNull();
		expect(getByText("ATC Ground")).not.toBeNull(); // full_title empty → title
		expect(getAllByRole("listitem")).toHaveLength(2);
	});

	it("calls onToggleMute with the file id when a row's icon button is clicked", () => {
		const onToggle = vi.fn();
		const onSolo = vi.fn();
		const { getAllByAltText } = renderList({ onToggleMute: onToggle, onToggleSolo: onSolo });
		fireEvent.mouseUp(getAllByAltText("Mute")[0]);
		expect(onToggle).toHaveBeenCalledWith(1);
		expect(onSolo).not.toHaveBeenCalled(); // icon click never solos
	});

	it("shows the muted icon (alt 'Unmute') for files in mutedItems", () => {
		const { getAllByRole } = renderList({ mutedItems: [2] });
		const imgs = getAllByRole("img");
		expect(imgs[0].getAttribute("alt")).toBe("Mute"); // id 1 unmuted → action Mute
		expect(imgs[1].getAttribute("alt")).toBe("Unmute"); // id 2 muted → action Unmute
	});

	it("renders a placeholder and no rows when segments is empty", () => {
		const { getByText, queryAllByRole } = renderList({ segments: [] });
		expect(getByText("—")).not.toBeNull();
		expect(queryAllByRole("listitem")).toHaveLength(0);
	});

	it("clicking a title solos that item; clicking it again un-solos", () => {
		const onSolo = vi.fn();
		const { getByText, unmount } = renderList({ onToggleSolo: onSolo });
		fireEvent.click(getByText("ATC Tower"));
		expect(onSolo).toHaveBeenCalledWith(1);
		unmount();
		// parent flips soloItemId; a second click reports the same id (toggle)
		onSolo.mockClear();
		const { getByText: getByText2 } = renderList({ soloItemId: 1, onToggleSolo: onSolo });
		fireEvent.click(getByText2("ATC Tower"));
		expect(onSolo).toHaveBeenCalledWith(1);
	});

	it("while soloed, other rows read as muted and the soloed row as audible", () => {
		// manual mutes are ignored for display while solo is active — what you
		// see is what you hear
		const { getAllByRole } = renderList({ soloItemId: 2, mutedItems: [2] });
		const imgs = getAllByRole("img");
		expect(imgs[0].getAttribute("alt")).toBe("Unmute"); // id 1 silenced by solo
		expect(imgs[1].getAttribute("alt")).toBe("Mute"); // id 2 audible (soloed)
	});

	it("pauses the marquee while a solo is active", () => {
		const { getByTestId, unmount } = renderList({ soloItemId: 1 });
		expect(getByTestId("marquee").getAttribute("data-play")).toBe("false");
		unmount();
		const { getByTestId: get2 } = renderList({ soloItemId: null });
		expect(get2("marquee").getAttribute("data-play")).toBe("true");
	});

	it("renders a plain list (no marquee) while the content fits the container", () => {
		overflow.value = false;
		const { queryByTestId, getAllByRole } = renderList();
		expect(queryByTestId("marquee")).toBeNull();
		expect(getAllByRole("listitem")).toHaveLength(2); // rows still render
	});

	it("wraps the list in the marquee only once the content overflows", () => {
		overflow.value = true;
		const { getByTestId, getAllByRole } = renderList();
		expect(getByTestId("marquee")).not.toBeNull();
		expect(getAllByRole("listitem")).toHaveLength(2);
	});
});
