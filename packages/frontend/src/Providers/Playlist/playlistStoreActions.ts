// Generic store plugin for the playlist engine: merge keys into any app's
// `data` without per-app set-state actions. Registered under its own prefix
// (TVContext-style) so it routes ahead of the core app reducer.
import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";

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

registerAppEventHandler("ClassicyAppPlaylist", classicyPlaylistEventHandler);
