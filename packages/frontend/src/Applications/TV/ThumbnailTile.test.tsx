import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { ThumbnailTile, thumbnailBalloonContent } from "./ThumbnailTile";

const FAKE_ITEM = {
	id: 7,
	url: "https://files.example.org/wabc/index.m3u8",
	source: "WABC",
	start_date: "2001-09-11T12:00:00",
	jump: 0,
} as unknown as MediaItem;

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function renderTile(
	overrides: Partial<React.ComponentProps<typeof ThumbnailTile>> = {},
) {
	const onPress = vi.fn();
	render(
		<ThumbnailTile
			item={FAKE_ITEM}
			className=""
			multiSelectMode={false}
			isActive={false}
			isSelected={false}
			thumbTs={1000201200}
			reorderHandlers={undefined}
			consumeSuppressedClick={() => false}
			onPress={onPress}
			{...overrides}
		/>,
	);
	return { onPress };
}

describe("thumbnailBalloonContent", () => {
	const base = {
		source: "WABC",
		multiSelectMode: false,
		isActive: false,
		isSelected: false,
	};

	it("single view, not focused: advises the click switches to the channel", () => {
		expect(thumbnailBalloonContent(base)).toBe(
			"Click to switch to WABC. Click and drag to move it elsewhere in the channel order.",
		);
	});

	it("single view, focused: says the channel is already playing", () => {
		expect(thumbnailBalloonContent({ ...base, isActive: true })).toBe(
			"You are watching WABC now. Click and drag to move it elsewhere in the channel order.",
		);
	});

	it("multiview, not in the grid: advises the click adds it", () => {
		expect(thumbnailBalloonContent({ ...base, multiSelectMode: true })).toBe(
			"Click to add WABC to the MultiView grid. Click and drag to move it elsewhere in the channel order.",
		);
	});

	it("multiview, in the grid: advises the click removes it", () => {
		expect(
			thumbnailBalloonContent({
				...base,
				multiSelectMode: true,
				isSelected: true,
			}),
		).toBe(
			"Click to remove WABC from the MultiView grid. Click and drag to move it elsewhere in the channel order.",
		);
	});

	it("falls back to a generic name for a source-less item", () => {
		expect(thumbnailBalloonContent({ ...base, source: undefined })).toContain(
			"Click to switch to this channel.",
		);
	});
});

describe("ThumbnailTile balloon", () => {
	it("shows the context-exact balloon after hovering", () => {
		vi.useFakeTimers();
		renderTile({ multiSelectMode: true, isSelected: true });
		fireEvent.mouseEnter(screen.getByRole("button"));
		act(() => {
			vi.advanceTimersByTime(700);
		});
		expect(
			screen.queryByText(/Click to remove WABC from the MultiView grid/),
		).not.toBeNull();
	});

	it("a press cancels the pending balloon", () => {
		vi.useFakeTimers();
		renderTile();
		const tile = screen.getByRole("button");
		fireEvent.mouseEnter(tile);
		fireEvent.pointerDown(tile, { pointerId: 1 });
		act(() => {
			vi.advanceTimersByTime(700);
		});
		expect(screen.queryByText(/Click to switch to WABC/)).toBeNull();
	});

	it("a click presses; a drag-suppressed click does not", () => {
		const { onPress } = renderTile({
			consumeSuppressedClick: () => true,
		});
		fireEvent.click(screen.getByRole("button"));
		expect(onPress).not.toHaveBeenCalled();

		cleanup();
		const second = renderTile();
		fireEvent.click(screen.getByRole("button"));
		expect(second.onPress).toHaveBeenCalledTimes(1);
	});
});
