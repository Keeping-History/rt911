import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const dialogProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyFileOpenDialog: (props: Record<string, unknown>) => {
		dialogProps.current = props;
		return props.open ? <div data-testid="file-open-dialog" /> : null;
	},
	useClassicyFileSystem: () => ({ fs: {}, separator: ":", resolve: () => undefined }),
}));
// Mutable holder so tests can simulate a later WS frame swapping in a *new*
// sources object (identity change), the way MediaStreamContext really updates.
const mediaStreamState = vi.hoisted(() => ({
	sources: { video: ["ABC"], audio: ["KCBS"], pager: [] as string[], usenet: [] as string[] },
}));
vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({ sources: mediaStreamState.sources }),
}));

import { PlaylistEditorMain } from "./PlaylistEditorMain";

const record = {
	id: "p1", title: "Lesson", status: "draft" as const, date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "restrict", entries: [{ kind: "media", app: "tv", itemId: "ABC" }] },
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	dialogProps.current = null;
	mediaStreamState.sources = { video: ["ABC"], audio: ["KCBS"], pager: [], usenet: [] };
});

describe("PlaylistEditorMain", () => {
	it("renders entry-kind branches and the loaded entry", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		expect(screen.getByText("Media")).not.toBeNull();
		expect(screen.getByText("TV · ABC")).not.toBeNull();
		expect(screen.getByTestId("playlist-timeline")).not.toBeNull();
	});

	it("opens the file dialog in multi mode for Add Media…", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));
		expect(screen.getByTestId("file-open-dialog")).not.toBeNull();
		expect(dialogProps.current?.selectionMode).toBe("multi");
		expect((dialogProps.current?.volumes as { id: string }[]).map((v) => v.id))
			.toEqual(["desktop", "fs-Macintosh HD", "rt911-archive"]);
	});

	it("adds entries from a dialog selection", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));
		act(() => {
			(dialogProps.current?.onOpenFunc as (s: unknown[]) => void)([
				{ volumeId: "rt911-archive", path: ["Radio Stations"],
					entry: { id: "radio-KCBS", name: "KCBS", kind: "file", fileType: "radio-station",
						meta: { app: "radio", itemId: "KCBS" } } },
			]);
		});
		expect(screen.getByText("RADIO · KCBS")).not.toBeNull();
	});

	it("selects an entry for editing via its Edit button and removes via Remove", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		expect(screen.getByRole("combobox", { name: /focus/i })).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(screen.queryByText("TV · ABC")).toBeNull();
	});

	it("archive volume reads live sources instead of the mount-render snapshot", async () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));

		const findArchiveVolume = () =>
			(dialogProps.current?.volumes as { id: string; list: (p: string[]) => Promise<{ name: string }[]> }[])
				.find((v) => v.id === "rt911-archive")!;

		const initialVolume = findArchiveVolume();
		const initialTv = await initialVolume.list(["TV Channels"]);
		expect(initialTv.map((e) => e.name)).toEqual(["ABC"]);

		// Simulate a later WS frame: MediaStreamContext hands back a *new*
		// sources object (identity change), the way real context updates work.
		mediaStreamState.sources = { video: ["XYZ"], audio: ["KCBS"], pager: [], usenet: [] };
		// Force a re-render of the same mounted instance (no remount) so the
		// component re-reads useMediaStream() and updates its live-sources ref.
		fireEvent.change(screen.getByRole("textbox", { name: /title/i }), { target: { value: "Lesson 2" } });

		// Same memoized volume instance (dialog's per-folder cache depends on
		// stable volume identity) must now reflect the updated sources.
		const laterVolume = findArchiveVolume();
		expect(laterVolume).toBe(initialVolume);
		const laterTv = await laterVolume.list(["TV Channels"]);
		expect(laterTv.map((e) => e.name)).toEqual(["XYZ"]);
	});
});
