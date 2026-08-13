import { ClassicyIcons } from "classicy";
import type { PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import type { EditorAction } from "./editorState";

export type AddActionId = "media" | "file" | "app" | "settings" | "jump" | "browser";

export interface AddAction {
	id: AddActionId;
	/** Palette button label — used as the accessible name, not drawn. */
	label: string;
	/** Title inside Edit > Add…, where "Add" is already implied by the submenu. */
	menuTitle: string;
	icon: string;
	balloon: string;
	/**
	 * The entry to append, or null for actions that instead open the file
	 * dialog (the user is picking something that already exists).
	 */
	entry: PlaylistEntry | null;
}

/**
 * The single definition of the Add surfaces. The Tools palette and the
 * Edit > Add… submenu both render from this array, so a new entry kind cannot
 * appear in one and go missing from the other.
 *
 * Icons are stock ClassicyIcons glyphs — period-correct and already bundled.
 * Every action carries a balloon because the palette buttons are icon-only.
 */
export const ADD_ACTIONS: AddAction[] = [
	{
		id: "media",
		label: "Add Media…",
		menuTitle: "Media…",
		icon: ClassicyIcons.system.quicktime.movie,
		balloon: "Add a TV channel, radio station, news story, or flight to this playlist.",
		entry: null,
	},
	{
		id: "file",
		label: "Add File…",
		menuTitle: "File…",
		icon: ClassicyIcons.system.files.document,
		balloon: "Add a document from the desktop, to be opened at a set time.",
		entry: null,
	},
	{
		id: "app",
		label: "Add App Rule",
		menuTitle: "App Rule",
		icon: ClassicyIcons.system.files.application,
		balloon: "Disable an application for students following this playlist.",
		entry: { kind: "app", appId: "TimeMachine.app", disabled: true },
	},
	{
		id: "settings",
		label: "Add Settings",
		menuTitle: "Settings",
		icon: ClassicyIcons.system.files.preferences,
		balloon: "Force an application's settings — for example, which TV channel it opens on.",
		entry: { kind: "settings", appId: "TV.app", values: {} },
	},
	{
		id: "jump",
		label: "Add Jump",
		menuTitle: "Jump",
		icon: ClassicyIcons.system.extensions.dateAndTime,
		balloon: "Move every student's clock to a new time when the playlist reaches this point.",
		entry: { kind: "jump", at: "", to: "" },
	},
	{
		id: "browser",
		label: "Add Browser",
		menuTitle: "Browser",
		icon: ClassicyIcons.system.network.globe,
		balloon: "Open a web page in the browser at a set time.",
		entry: { kind: "browser", url: "http://", at: "" },
	},
];

export interface AddActionHandlers {
	playlistId: string;
	edit: (playlistId: string, action: EditorAction) => void;
	setDialogMode: (mode: "media" | "file") => void;
}

/** Perform one Add action against a specific playlist. */
export function runAddAction(action: AddAction, handlers: AddActionHandlers): void {
	if (action.entry === null) {
		// Only media and file have a null entry, and their ids are exactly the
		// dialog's two modes.
		handlers.setDialogMode(action.id as "media" | "file");
		return;
	}
	handlers.edit(handlers.playlistId, {
		type: "addEntries",
		entries: [{ entry: action.entry }],
	});
}
