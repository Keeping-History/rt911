import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EditorEntry } from "./editorState";

vi.mock("./resolveTimelineMeta", () => ({
	resolveTimelineMeta: vi.fn(async () => new Map()),
}));

import { PlaylistTimeline } from "./PlaylistTimeline";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const entries: EditorEntry[] = [
	{
		uid: "e1",
		entry: {
			kind: "media", app: "tv", itemId: "ABC",
			start: "2001-09-11T12:00:00Z", end: "2001-09-11T13:00:00Z",
		},
	},
	{
		uid: "e2",
		entry: { kind: "media", app: "news", itemId: "42" },
		timelineMeta: { publishedAt: "2001-09-11T12:30:00Z" },
	},
];

describe("PlaylistTimeline", () => {
	it("renders one bar and one flag, and clicking each selects the right uid", () => {
		const onSelect = vi.fn();
		render(<PlaylistTimeline entries={entries} selectedUid={null} onSelect={onSelect} />);

		const bars = document.querySelectorAll(".playlistTimelineBar");
		expect(bars).toHaveLength(1);
		expect(bars[0].getAttribute("title")).toBe("ABC");

		const flags = screen.getAllByRole("button", { name: "⚑" });
		expect(flags).toHaveLength(1);

		fireEvent.click(bars[0]);
		expect(onSelect).toHaveBeenCalledWith("e1");

		fireEvent.click(flags[0]);
		expect(onSelect).toHaveBeenCalledWith("e2");
	});
});
