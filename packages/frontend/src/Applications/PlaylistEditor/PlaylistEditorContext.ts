import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";

export const PLAYLIST_EDITOR_APP_ID = "PlaylistEditor.app";

/**
 * Persist the timeline's zoom level.
 *
 * This is the editor's only piece of classicy-store state, and it lives here
 * rather than in the per-document `EditorStates` for one specific reason:
 * `editorStatesReducer`'s "close" case *deletes* a document's entry, so a zoom
 * kept there would be discarded by exactly the action it needs to survive —
 * closing the window and opening it again.
 *
 * It is app-level rather than per-playlist, so it is a preference ("how I like
 * to look at timelines") rather than a property of one document. Two document
 * windows open at once therefore share it.
 */
/*
 * ⚠ The prefix below is deliberately NOT "ClassicyAppPlaylistEditor".
 *
 * classicy routes an action to exactly one handler, by first registered prefix
 * whose string the action type starts with:
 *
 *     Ue.find(({ prefix }) => action.type.startsWith(prefix))
 *
 * `Providers/Playlist/playlistStoreActions` already claims "ClassicyAppPlaylist"
 * for this same app id, and that string is a prefix of "ClassicyAppPlaylistEditor…".
 * So a "ClassicyAppPlaylistEditorSetTimelineZoom" action would be matched by
 * *that* handler — which returns the store untouched for anything other than its
 * own MergeData action — and the zoom would silently never persist. Which
 * handler wins would come down to module import order.
 *
 * Registering the same prefix twice does not help either: the registry keeps the
 * first and drops the second without complaint.
 *
 * So this module namespaces its actions under a prefix that overlaps nothing.
 * `appManifests.test.ts` has a guard that fails if any registered prefix is a
 * prefix of another.
 */
export const playlistSetTimelineZoom = (zoom: number): ActionMessage => ({
	type: "ClassicyAppTimelineZoomSet",
	zoom,
});

export const classicyPlaylistEditorEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const app = ds.System.Manager.Applications.apps[PLAYLIST_EDITOR_APP_ID];
	if (!app) return ds;
	const appData = app.data ?? {};

	switch (action.type) {
		case "ClassicyAppTimelineZoomSet":
			app.data = { ...appData, timelineZoom: action.zoom as number };
			return ds;
		default:
			return ds;
	}
};

export const PlaylistEditorDataSchema = z.looseObject({
	timelineZoom: z
		.number()
		.optional()
		.describe("How far the playlist timeline is zoomed in. 1 shows all ten days at once."),
});

export type PlaylistEditorData = z.infer<typeof PlaylistEditorDataSchema>;

registerApp({
	id: PLAYLIST_EDITOR_APP_ID,
	// Repeated verbatim from playlistStoreActions, which registers the app's
	// other prefix. The registry keeps the first description it sees, and
	// CLAUDE.md's multi-module rule is that both modules state an identical
	// literal rather than importing one another.
	description: "Author teacher playlists and drive live rooms (jump, focus, message, lock).",
	prefix: "ClassicyAppTimelineZoom",
	handler: classicyPlaylistEditorEventHandler,
	actions: {
		ClassicyAppTimelineZoomSet: {
			description: "Persist the playlist timeline's zoom level across window reopens.",
			params: z.object({
				zoom: z.number().describe("Zoom level; 1 shows the whole ten-day span."),
			}),
		},
	},
	state: PlaylistEditorDataSchema,
});
