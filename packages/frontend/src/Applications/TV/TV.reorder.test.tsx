import { cleanup, fireEvent, render } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

// Captures every dispatched action so we can assert what a gesture did (and,
// just as importantly, what it did NOT do).
const dispatched = vi.hoisted(() => [] as Record<string, unknown>[]);
// Stable identity, matching the real hook (classicy returns a module-level
// `dispatch` constant). A fresh closure per render would re-fire TV.tsx's
// effects that list the dispatcher in their deps, polluting `dispatched`.
const dispatch = vi.hoisted(
	() => (a: Record<string, unknown>) => {
		dispatched.push(a);
	},
);
const mockAppData = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const mockItems = vi.hoisted(() => ({ value: null as unknown[] | null }));

const FAKE_ITEM = {
	id: 7,
	url: "https://files.example.org/wabc/index.m3u8",
	source: "WABC",
	start_date: "2001-09-11T12:00:00",
	jump: 0,
} as unknown as MediaItem;

const FAKE_ITEM_2 = {
	id: 8,
	url: "https://files.example.org/wnbc/index.m3u8",
	source: "WNBC",
	start_date: "2001-09-11T12:00:00",
	jump: 0,
} as unknown as MediaItem;

vi.mock("classicy", async (importOriginal) => {
	const actual = await importOriginal<typeof import("classicy")>();
	const fakeState = () => ({
		System: {
			Manager: {
				Applications: {
					apps: {
						"TV.app": { data: mockAppData.value, open: true, windows: [] },
					},
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
		useAppManagerDispatch: () => dispatch,
		useClassicyDateTime: () => ({
			dateTime: "2001-09-11T12:40:00.000Z",
			paused: false,
		}),
	};
});

vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({
		items: mockItems.value ?? [FAKE_ITEM],
		sources: { video: ["WABC", "WNBC"], audio: [], pager: [], usenet: [] },
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
	mockItems.value = null;
	dispatched.length = 0;
});

/** jsdom has no layout: give each tile a box so drop-target resolution works. */
function stubTileBoxes() {
	document.querySelectorAll<HTMLElement>("[data-source]").forEach((tile, i) => {
		tile.getBoundingClientRect = () =>
			({ left: i * 100, right: (i + 1) * 100, top: 0, bottom: 90 }) as DOMRect;
	});
}

const tile = (source: string) =>
	document.querySelector(`[data-source="${source}"]`) as HTMLElement;

describe("TV thumbnail reorder", () => {
	it("a plain click still focuses the channel", () => {
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);
		stubTileBoxes();
		dispatched.length = 0;
		const target = tile("WNBC");
		fireEvent.pointerDown(target, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.pointerUp(target, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.click(target);
		expect(
			dispatched.some(
				(a) => a.type === "ClassicyAppTVSetActivePlayer" && a.activePlayer === 8,
			),
		).toBe(true);
	});

	it("a drag reorders and does not focus", () => {
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);
		stubTileBoxes();
		dispatched.length = 0;
		const target = tile("WABC");
		fireEvent.pointerDown(target, { clientX: 10, clientY: 10, pointerId: 1 });
		fireEvent.pointerMove(target, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.pointerUp(target, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.click(target);
		expect(
			dispatched.some(
				(a) =>
					a.type === "ClassicyAppTVSetChannelOrder" &&
					JSON.stringify(a.channelOrder) === JSON.stringify(["WNBC", "WABC"]),
			),
		).toBe(true);
		expect(dispatched.some((a) => a.type === "ClassicyAppTVSetActivePlayer")).toBe(false);
	});

	it("a plain click in multiview mode still toggles selection", () => {
		mockAppData.value = { multiSelectMode: true };
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);
		stubTileBoxes();
		dispatched.length = 0;
		const target = tile("WNBC");
		fireEvent.pointerDown(target, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.pointerUp(target, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.click(target);
		expect(
			dispatched.some(
				(a) =>
					a.type === "ClassicyAppTVSetGridState" &&
					(a.selectedPlayers as number[] | undefined)?.includes(8),
			),
		).toBe(true);
	});

	it("renders channels in the saved order", () => {
		mockAppData.value = { channelOrder: ["WNBC", "WABC"] };
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);
		const sources = Array.from(document.querySelectorAll("[data-source]")).map((el) =>
			el.getAttribute("data-source"),
		);
		expect(sources).toEqual(["WNBC", "WABC"]);
	});
});
