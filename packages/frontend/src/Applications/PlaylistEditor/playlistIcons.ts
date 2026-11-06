import { registerClassicyIcons } from "@classicy/classicy";
import appPng from "./app.png";
import docPng from "./doc.png";
import editDateTimePng from "./edit-date-time.png";
import editJumpPng from "./edit-jump.png";
import editPng from "./edit.png";
import trashPng from "./trash.png";

/**
 * The Playlists app's local PNGs, registered once in Classicy's icon registry
 * at applications.playlistEditor. A dedicated module (rather than
 * registering in PlaylistEditor.tsx) because addActions.ts needs these at its
 * own module-init time, which runs before PlaylistEditor.tsx's body.
 *
 * registerClassicyIcons deep-merges, so nothing else in the tree is touched.
 * Read them from playlistEditorIcons: Classicy 3's ClassicyIcons constant is a
 * snapshot of the shipped tree and never shows registrations.
 */
const ICONS = registerClassicyIcons({
	applications: {
		playlistEditor: {
			app: appPng,
			doc: docPng,
			edit: editPng,
			trash: trashPng,
			editJump: editJumpPng,
			editDateTime: editDateTimePng,
		},
	},
});

export const playlistEditorIcons = ICONS.applications.playlistEditor;
