import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	classicyPlaylistEditorEventHandler,
	PLAYLIST_EDITOR_APP_ID,
	playlistSetTimelineZoom,
} from "./PlaylistEditorContext";

const storeWith = (data?: Record<string, unknown>) =>
	({
		System: { Manager: { Applications: { apps: { [PLAYLIST_EDITOR_APP_ID]: { data } } } } },
	}) as unknown as ClassicyStore;

const dataOf = (ds: ClassicyStore) =>
	ds.System.Manager.Applications.apps[PLAYLIST_EDITOR_APP_ID].data as
		| Record<string, unknown>
		| undefined;

describe("playlist editor store", () => {
	it("persists the timeline zoom", () => {
		const ds = classicyPlaylistEditorEventHandler(storeWith(), playlistSetTimelineZoom(8));
		expect(dataOf(ds)?.timelineZoom).toBe(8);
	});

	it("leaves the app's other data untouched when zoom changes", () => {
		// The handler writes through a spread; a regression that replaced
		// `app.data` wholesale would silently drop unrelated keys the kernel or
		// a future feature put there.
		const ds = classicyPlaylistEditorEventHandler(
			storeWith({ openFiles: ["a"], timelineZoom: 2 }),
			playlistSetTimelineZoom(16),
		);
		expect(dataOf(ds)).toEqual({ openFiles: ["a"], timelineZoom: 16 });
	});

	it("ignores actions for other apps and survives the app not being open", () => {
		const untouched = classicyPlaylistEditorEventHandler(storeWith({ timelineZoom: 4 }), {
			type: "ClassicyAppSomethingElse",
		});
		expect(dataOf(untouched)?.timelineZoom).toBe(4);

		const noApp = { System: { Manager: { Applications: { apps: {} } } } } as unknown as ClassicyStore;
		expect(() => classicyPlaylistEditorEventHandler(noApp, playlistSetTimelineZoom(2))).not.toThrow();
	});
});
