import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const dialogProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyFileOpenDialog: (props: Record<string, unknown>) => {
		dialogProps.current = props;
		return props.open ? <div data-testid="file-open-dialog" /> : null;
	},
	useClassicyFileSystem: () => ({ fs: {}, separator: ":", resolve: () => undefined }),
}));
const apiMocks = vi.hoisted(() => ({ updatePlaylist: vi.fn() }));
vi.mock("../../Providers/Auth/playlistApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../Providers/Auth/playlistApi")>()),
	updatePlaylist: apiMocks.updatePlaylist,
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

describe("PlaylistEditorMain dirty-close", () => {
	const noop = () => {};

	it("reports dirty state upward via onDirtyChange as it changes", () => {
		const onDirtyChange = vi.fn();
		render(
			<PlaylistEditorMain record={record} onBack={noop} onDirtyChange={onDirtyChange} />,
		);
		expect(onDirtyChange).toHaveBeenCalledWith(false);

		fireEvent.change(screen.getByRole("textbox", { name: /title/i }), { target: { value: "Lesson 2" } });
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
	});

	it("renders the normal editor body when closeRequested is false", () => {
		render(<PlaylistEditorMain record={record} onBack={noop} closeRequested={false} />);
		expect(screen.getByText("Media")).not.toBeNull();
		expect(screen.queryByText(/before closing\?/)).toBeNull();
	});

	it("swaps to the three-button close-confirm strip when closeRequested is true, replacing the editor body", () => {
		const { rerender } = render(
			<PlaylistEditorMain record={record} onBack={noop} closeRequested={false} />,
		);
		fireEvent.change(screen.getByRole("textbox", { name: /title/i }), { target: { value: "Lesson X" } });
		rerender(<PlaylistEditorMain record={record} onBack={noop} closeRequested={true} />);

		expect(screen.getByText('Save changes to "Lesson X" before closing?')).not.toBeNull();
		expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "Don't Save" })).not.toBeNull();
		expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
		// editor body (tree/add-bar) is replaced, not just hidden alongside it
		expect(screen.queryByText("Media")).toBeNull();
		expect(screen.queryByRole("button", { name: "Add Media…" })).toBeNull();
	});

	it("Don't Save quits directly without saving", () => {
		const onQuit = vi.fn();
		const { rerender } = render(
			<PlaylistEditorMain record={record} onBack={noop} closeRequested={false} onQuit={onQuit} />,
		);
		fireEvent.change(screen.getByRole("textbox", { name: /title/i }), { target: { value: "Lesson X" } });
		rerender(<PlaylistEditorMain record={record} onBack={noop} closeRequested={true} onQuit={onQuit} />);

		fireEvent.click(screen.getByRole("button", { name: "Don't Save" }));
		expect(onQuit).toHaveBeenCalled();
		expect(apiMocks.updatePlaylist).not.toHaveBeenCalled();
	});

	it("Cancel returns to the editor (strip gone, editor visible again)", () => {
		const onCancelClose = vi.fn();
		const { rerender } = render(
			<PlaylistEditorMain record={record} onBack={noop} closeRequested={false} onCancelClose={onCancelClose} />,
		);
		fireEvent.change(screen.getByRole("textbox", { name: /title/i }), { target: { value: "Lesson X" } });
		rerender(
			<PlaylistEditorMain record={record} onBack={noop} closeRequested={true} onCancelClose={onCancelClose} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancelClose).toHaveBeenCalled();

		// parent acts on onCancelClose by flipping closeRequested back to false
		rerender(
			<PlaylistEditorMain record={record} onBack={noop} closeRequested={false} onCancelClose={onCancelClose} />,
		);
		expect(screen.queryByText(/before closing\?/)).toBeNull();
		expect(screen.getByText("Media")).not.toBeNull();
	});

	it("the strip's Save button runs SaveBar's full save path and quits on success", async () => {
		apiMocks.updatePlaylist.mockResolvedValue({ ...record, title: "Lesson X" });
		const onQuit = vi.fn();
		const { rerender } = render(
			<PlaylistEditorMain record={record} onBack={noop} closeRequested={false} onQuit={onQuit} />,
		);
		fireEvent.change(screen.getByRole("textbox", { name: /title/i }), { target: { value: "Lesson X" } });
		rerender(<PlaylistEditorMain record={record} onBack={noop} closeRequested={true} onQuit={onQuit} />);

		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(onQuit).toHaveBeenCalled());
		expect(apiMocks.updatePlaylist).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ title: "Lesson X" }),
		);
	});
});
