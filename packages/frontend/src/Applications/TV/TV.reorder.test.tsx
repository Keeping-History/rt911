import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

// Seeded TV.app data handed to useAppManager; tests may override, reset in afterEach.
const mockAppData = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
// Every action sent through useAppManagerDispatch, for asserting on persists.
const dispatched = vi.hoisted(() => ({ actions: [] as Record<string, unknown>[] }));

const makeItem = (id: number, source: string) =>
	({
		id,
		url: `https://files.example.org/${source.toLowerCase()}/index.m3u8`,
		source,
		start_date: "2001-09-11T12:00:00",
		jump: 0,
		subtitles: "",
	}) as unknown as MediaItem;

const ITEMS = [makeItem(1, "WABC"), makeItem(2, "WCBS"), makeItem(3, "WNBC")];

vi.mock("classicy", async (importOriginal) => {
	const actual = await importOriginal<typeof import("classicy")>();
	// Built per call so a test's mockAppData override is visible to the selector.
	const fakeState = () => ({
		System: {
			Manager: {
				Applications: {
					apps: { "TV.app": { data: mockAppData.value, open: true, windows: [] } },
				},
			},
		},
	});
	return {
		...actual,
		ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
		ClassicyWindow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
		ClassicyButton: ({
			children,
			onClickFunc,
		}: {
			children?: React.ReactNode;
			onClickFunc?: () => void;
		}) => (
			<button type="button" onClick={onClickFunc}>
				{children}
			</button>
		),
		ClassicySlider: () => <input type="range" readOnly />,
		QuickTimeVideoEmbed: () => <div data-testid="qt-embed" />,
		useAppManager: (selector: (s: unknown) => unknown) => selector(fakeState()),
		useAppManagerDispatch: () => (action: Record<string, unknown>) => {
			dispatched.actions.push(action);
		},
		useClassicyDateTime: () => ({ dateTime: "2001-09-11T12:40:00.000Z", paused: false }),
	};
});

vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({
		items: ITEMS,
		sources: { video: ["WABC", "WCBS", "WNBC"], audio: [], pager: [], usenet: [] },
	}),
}));

vi.mock("../../openreplay", () => ({
	trackAppToggle: () => {},
	trackChannelChange: () => {},
}));

import { TV } from "./TV";

afterEach(() => {
	cleanup();
	mockAppData.value = {};
	dispatched.actions = [];
});

/** The strip's channel labels, in DOM order. */
const stripOrder = () =>
	screen
		.getAllByRole("button", { name: /^(WABC|WCBS|WNBC)$/ })
		.map((b) => b.textContent);

describe("thumbnail strip ordering", () => {
	it("renders wire order when no channelOrder is saved", () => {
		render(<TV />);
		expect(stripOrder()).toEqual(["WABC", "WCBS", "WNBC"]);
	});

	it("renders the persisted channelOrder", () => {
		mockAppData.value = { channelOrder: ["WNBC", "WABC", "WCBS"] };
		render(<TV />);
		expect(stripOrder()).toEqual(["WNBC", "WABC", "WCBS"]);
	});

	it("appends channels missing from the persisted order", () => {
		mockAppData.value = { channelOrder: ["WNBC"] };
		render(<TV />);
		expect(stripOrder()).toEqual(["WNBC", "WABC", "WCBS"]);
	});
});

/** Give the strip and its buttons deterministic layout in jsdom:
 *  three 100×75 thumbnails at x = 0 / 100 / 200 inside a 300px strip. */
function mockStripLayout() {
	const strip = document.querySelector(
		"[class*='tvThumbnailStrip']",
	) as HTMLElement;
	strip.getBoundingClientRect = () =>
		({
			left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100,
			x: 0, y: 0, toJSON: () => ({}),
		}) as DOMRect;
	const buttons = Array.from(strip.querySelectorAll("button"));
	buttons.forEach((b, i) => {
		b.getBoundingClientRect = () =>
			({
				left: i * 100, top: 0, width: 100, height: 75,
				right: i * 100 + 100, bottom: 75, x: i * 100, y: 0, toJSON: () => ({}),
			}) as DOMRect;
	});
	return buttons;
}

const reorderActions = () =>
	dispatched.actions.filter((a) => a.type === "ClassicyAppTVSetChannelOrder");

describe("thumbnail drag-to-reorder", () => {
	it("dispatches the new channel order on drop", () => {
		render(<TV />);
		const [first] = mockStripLayout();
		// Drag WABC (index 0) to the far right (past WNBC's midpoint at 250).
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 1, button: 0 });
		fireEvent.pointerMove(first, { clientX: 270, clientY: 30, pointerId: 1 });
		fireEvent.pointerUp(first, { clientX: 270, clientY: 30, pointerId: 1 });
		expect(dispatched.actions).toContainEqual({
			type: "ClassicyAppTVSetChannelOrder",
			channelOrder: ["WCBS", "WNBC", "WABC"],
		});
	});

	it("shows the outline and insertion bar only while dragging", () => {
		const { container } = render(<TV />);
		const [first] = mockStripLayout();
		expect(container.querySelector("[class*='tvDragOutline']")).toBeNull();
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 1, button: 0 });
		// Below the movement threshold: still nothing.
		fireEvent.pointerMove(first, { clientX: 52, clientY: 30, pointerId: 1 });
		expect(container.querySelector("[class*='tvDragOutline']")).toBeNull();
		fireEvent.pointerMove(first, { clientX: 150, clientY: 30, pointerId: 1 });
		expect(container.querySelector("[class*='tvDragOutline']")).not.toBeNull();
		expect(container.querySelector("[class*='tvDragInsertionBar']")).not.toBeNull();
		fireEvent.pointerUp(first, { clientX: 150, clientY: 30, pointerId: 1 });
		expect(container.querySelector("[class*='tvDragOutline']")).toBeNull();
	});

	it("does not dispatch for a no-op drop or a sub-threshold press", () => {
		render(<TV />);
		const [first] = mockStripLayout();
		// Sub-threshold press → click semantics, no reorder dispatch.
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 1, button: 0 });
		fireEvent.pointerUp(first, { clientX: 51, clientY: 30, pointerId: 1 });
		// Real drag dropped back into its own slot.
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 2, button: 0 });
		fireEvent.pointerMove(first, { clientX: 70, clientY: 30, pointerId: 2 });
		fireEvent.pointerUp(first, { clientX: 40, clientY: 30, pointerId: 2 });
		expect(reorderActions()).toEqual([]);
	});

	it("cancels the drag on Escape without dispatching", () => {
		const { container } = render(<TV />);
		const [first] = mockStripLayout();
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 1, button: 0 });
		fireEvent.pointerMove(first, { clientX: 250, clientY: 30, pointerId: 1 });
		expect(container.querySelector("[class*='tvDragOutline']")).not.toBeNull();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(container.querySelector("[class*='tvDragOutline']")).toBeNull();
		fireEvent.pointerUp(first, { clientX: 250, clientY: 30, pointerId: 1 });
		expect(reorderActions()).toEqual([]);
	});

	it("still tunes the channel on a plain click", () => {
		render(<TV />);
		const buttons = mockStripLayout();
		// Mount effects already dispatched an initial active-player persist;
		// only the click's dispatch matters here.
		dispatched.actions = [];
		fireEvent.click(buttons[1]); // WCBS, id 2
		expect(dispatched.actions).toContainEqual({
			type: "ClassicyAppTVSetActivePlayer",
			activePlayer: 2,
		});
	});
});
