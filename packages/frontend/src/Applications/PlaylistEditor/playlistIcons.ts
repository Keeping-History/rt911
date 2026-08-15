import { ClassicyIcons, registerClassicyIcons } from "classicy";
import appPng from "./app.png";
import docPng from "./doc.png";
import editDateTimePng from "./edit-date-time.png";
import editJumpPng from "./edit-jump.png";
import editPng from "./edit.png";
import trashPng from "./trash.png";

/**
 * The Playlists app's local PNGs, registered once under
 * ClassicyIcons.applications.playlistEditor. A dedicated module (rather than
 * registering in PlaylistEditor.tsx) because addActions.ts needs these at its
 * own module-init time, which runs before PlaylistEditor.tsx's body.
 *
 * registerClassicyIcons assigns SHALLOWLY at the top level, so the existing
 * applications namespace must be spread in, not replaced.
 */
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
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
