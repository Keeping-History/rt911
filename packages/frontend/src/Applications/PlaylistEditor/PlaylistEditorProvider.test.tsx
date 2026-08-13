import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomCommandError } from "../../Providers/Playlist/roomApi";
import { PlaylistEditorProvider, usePlaylistEditor } from "./PlaylistEditorProvider";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";

afterEach(cleanup);

const rec = (id: string, title = "Lesson"): PlaylistRecord => ({
	id, title, status: "draft", date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "annotate", entries: [] },
});

let api: ReturnType<typeof usePlaylistEditor>;
function Probe() {
	api = usePlaylistEditor();
	return <div data-testid="ids">{api.openIds.join(",")}</div>;
}
const renderProvider = (sendLock = vi.fn().mockResolvedValue(undefined)) =>
	render(
		<PlaylistEditorProvider sendLock={sendLock}>
			<Probe />
		</PlaylistEditorProvider>,
	);

describe("PlaylistEditorProvider", () => {
	it("tracks open documents in open order and makes the newest active", () => {
		renderProvider();

		act(() => api.openPlaylist(rec("p1")));
		act(() => api.openPlaylist(rec("p2")));

		expect(screen.getByTestId("ids").textContent).toBe("p1,p2");
		expect(api.activeId).toBe("p2");
	});

	it("closing the active document clears activeId", () => {
		renderProvider();
		act(() => api.openPlaylist(rec("p1")));

		act(() => api.closePlaylist("p1"));

		expect(api.openIds).toEqual([]);
		expect(api.activeId).toBeNull();
	});

	// The palette targets the last-focused document; focusing the palette
	// itself must not retarget it.
	it("setActive retargets to the focused document", () => {
		renderProvider();
		act(() => api.openPlaylist(rec("p1")));
		act(() => api.openPlaylist(rec("p2")));

		act(() => api.setActive("p1"));

		expect(api.activeId).toBe("p1");
	});

	it("locks the clock only after the server accepts, and per playlist", async () => {
		const sendLock = vi.fn().mockResolvedValue(undefined);
		renderProvider(sendLock);
		act(() => api.openPlaylist(rec("p1")));
		act(() => api.openPlaylist(rec("p2")));

		await act(async () => {
			await api.toggleClockLock("p1");
		});

		expect(sendLock).toHaveBeenCalledWith("p1", "clock", true);
		expect(api.locks.p1?.clock).toBe(true);
		// Locking one classroom must not mark another as locked.
		expect(api.locks.p2?.clock ?? false).toBe(false);
	});

	it("leaves the lock off and reports why when the command is refused", async () => {
		const sendLock = vi
			.fn()
			.mockRejectedValue(new RoomCommandError("Only the person who created this playlist can control it."));
		renderProvider(sendLock);
		act(() => api.openPlaylist(rec("p1")));

		await act(async () => {
			await api.toggleClockLock("p1");
		});

		expect(api.locks.p1?.clock ?? false).toBe(false);
		expect(api.lockError).toEqual({
			playlistId: "p1",
			message: "Only the person who created this playlist can control it.",
		});
	});

	it("reports a generic failure for a non-RoomCommandError", async () => {
		const sendLock = vi.fn().mockRejectedValue(new Error("socket died"));
		renderProvider(sendLock);
		act(() => api.openPlaylist(rec("p1")));

		await act(async () => {
			await api.toggleClockLock("p1");
		});

		expect(api.lockError?.message).toBe("Command failed.");
	});
});
