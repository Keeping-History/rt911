// Generic store plugin for the playlist engine: merge keys into any app's
// `data` without per-app set-state actions. Registered under its own prefix
// (TVContext-style) so it routes ahead of the core app reducer.
import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";

/** Merge keys into apps[appId].data — used for playlist settings entries. */
export const playlistMergeAppData = (
	appId: string,
	values: Record<string, unknown>,
): ActionMessage => ({ type: "ClassicyAppPlaylistMergeData", appId, values });

export const classicyPlaylistEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (action.type !== "ClassicyAppPlaylistMergeData") return ds;
	const app = ds.System.Manager.Applications.apps[action.appId as string];
	if (!app) return ds;
	app.data = { ...(app.data ?? {}), ...(action.values as Record<string, unknown>) };
	return ds;
};

registerApp({
	id: "PlaylistEditor.app",
	description: "Author teacher playlists and drive live rooms (jump, focus, message, lock).",
	prefix: "ClassicyAppPlaylist",
	handler: classicyPlaylistEventHandler,
	actions: {
		ClassicyAppPlaylistMergeData: {
			description: "Merge keys into another app's data slice (playlist settings entries).",
			params: z.object({
				appId: z.string().describe("Target app id whose data receives the merge."),
				values: z.record(z.string(), z.unknown()).describe("Keys merged into the target app's data."),
			}),
		},
	},
	// No state schema: this handler writes into OTHER apps' data slices, and
	// PlaylistEditor.app itself persists nothing through this prefix.
});
