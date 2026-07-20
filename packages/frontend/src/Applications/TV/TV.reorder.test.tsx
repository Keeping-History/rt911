import { cleanup, render, screen } from "@testing-library/react";
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
