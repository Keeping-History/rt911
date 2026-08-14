import type { ClassicyMenuItem } from "classicy";
import type { AddAction } from "./addActions";
import type { LockState } from "./PlaylistEditorProvider";
import { listSettingsApps } from "./settingsRegistry";

/** `{id:"spacer"}` renders as an <hr> in classicy — the library's separator. */
const SPACER: ClassicyMenuItem = { id: "spacer" };

export interface DocumentFileMenuOptions {
	dirty: boolean;
	status: "draft" | "published";
	onOpenList: () => void;
	onSave: () => void;
	onRename: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
	onSetStatus: (status: "draft" | "published") => void;
	quitItem: ClassicyMenuItem;
}

export function documentFileMenu(o: DocumentFileMenuOptions): ClassicyMenuItem {
	return {
		id: "file",
		title: "File",
		menuChildren: [
			{ id: "playlist_file_open", title: "Open…", onClickFunc: o.onOpenList },
			SPACER,
			{
				id: "playlist_file_save",
				title: "Save",
				keyboardShortcut: "S",
				disabled: !o.dirty,
				onClickFunc: o.onSave,
			},
			// "Rename…", not "Save As…": it renames in place, and File >
			// Duplicate is what makes a copy.
			{ id: "playlist_file_rename", title: "Rename…", onClickFunc: o.onRename },
			{ id: "playlist_file_duplicate", title: "Duplicate", onClickFunc: o.onDuplicate },
			SPACER,
			{
				id: "playlist_file_status",
				title: "Status",
				menuChildren: [
					{
						id: "playlist_status_draft",
						title: "Draft",
						checked: o.status === "draft",
						onClickFunc: () => o.onSetStatus("draft"),
					},
					{
						id: "playlist_status_published",
						title: "Published",
						checked: o.status === "published",
						onClickFunc: () => o.onSetStatus("published"),
					},
				],
			},
			SPACER,
			{ id: "playlist_file_delete", title: "Delete…", onClickFunc: o.onDelete },
			SPACER,
			o.quitItem,
		],
	};
}

export const MODE_BALLOONS = {
	restrict:
		"Students see only what this playlist includes. Everything else on the desktop is hidden or disabled.",
	annotate:
		"Students keep the full desktop. This playlist only adds notes, jumps, and scheduled events on top of it.",
} as const;

export function documentEditMenu(o: {
	mode: "restrict" | "annotate";
	onSetMode: (mode: "restrict" | "annotate") => void;
	addItems: ClassicyMenuItem[];
}): ClassicyMenuItem {
	return {
		id: "edit",
		title: "Edit",
		menuChildren: [
			{
				id: "playlist_edit_restrict",
				title: "Restrict",
				checked: o.mode === "restrict",
				balloon: { title: "Restrict", content: MODE_BALLOONS.restrict },
				onClickFunc: () => o.onSetMode("restrict"),
			},
			{
				id: "playlist_edit_annotate",
				title: "Annotate",
				checked: o.mode === "annotate",
				balloon: { title: "Annotate", content: MODE_BALLOONS.annotate },
				onClickFunc: () => o.onSetMode("annotate"),
			},
			SPACER,
			{ id: "playlist_edit_add", title: "Add…", menuChildren: o.addItems },
		],
	};
}

/** The Add Settings app choices, shared by the Edit > Add… submenu and the
 * palette's dropdown so the two surfaces can never disagree. */
export function settingsAppMenuItems(
	runSettings: (appId: string) => void,
): ClassicyMenuItem[] {
	return listSettingsApps().map((app) => ({
		id: `playlist_add_settings_${app.appId}`,
		title: app.name,
		onClickFunc: () => runSettings(app.appId),
	}));
}

/** Build the Edit > Add… children from the shared action list. */
export function addMenuItems(
	actions: AddAction[],
	run: (action: AddAction) => void,
	runSettings: (appId: string) => void,
): ClassicyMenuItem[] {
	return actions.map((action) => ({
		id: `playlist_add_${action.id}`,
		title: action.menuTitle,
		icon: action.icon,
		balloon: { title: action.label, content: action.balloon },
		// Settings fans out per registered app instead of running directly.
		...(action.id === "settings"
			? { menuChildren: settingsAppMenuItems(runSettings) }
			: { onClickFunc: () => run(action) }),
	}));
}

export const CLOCK_LOCK_BALLOON =
	"Students following this playlist cannot change the time until you unlock the clock.";
export const CONTENTS_LOCK_BALLOON =
	"Not yet available. This will stop students from switching channels or stations on their own.";

export function documentControlMenu(o: {
	lock: LockState;
	onToggleClock: () => void;
}): ClassicyMenuItem {
	return {
		id: "control",
		title: "Control",
		menuChildren: [
			{
				id: "playlist_control_clock",
				title: "Lock Clock",
				checked: o.lock.clock,
				disabled: o.lock.busy,
				balloon: { title: "Lock Clock", content: CLOCK_LOCK_BALLOON },
				onClickFunc: o.onToggleClock,
			},
			// Content locking is not built. Present so the pair reads as the
			// pair it will become, disabled so it cannot imply an effect it
			// does not have, and deliberately given no handler.
			{
				id: "playlist_control_contents",
				title: "Lock Contents",
				checked: false,
				disabled: true,
				balloon: { title: "Lock Contents", content: CONTENTS_LOCK_BALLOON },
			},
		],
	};
}

export function windowMenu(o: {
	onFocusTools: () => void;
	onFocusSettings: () => void;
	onFocusList: () => void;
	onFocusDocument: (playlistId: string) => void;
	documents: { playlistId: string; title: string }[];
}): ClassicyMenuItem {
	return {
		id: "window",
		title: "Window",
		menuChildren: [
			{ id: "playlist_window_tools", title: "Tools", onClickFunc: o.onFocusTools },
			{ id: "playlist_window_settings", title: "Settings", onClickFunc: o.onFocusSettings },
			SPACER,
			{ id: "playlist_window_list", title: "My Playlists", onClickFunc: o.onFocusList },
			// Rebuilt every render from the open list — never snapshotted — so a
			// window opening or closing shows up in the same render that mounts
			// or unmounts it.
			...o.documents.map((doc) => ({
				id: `playlist_window_doc_${doc.playlistId}`,
				title: doc.title,
				onClickFunc: () => o.onFocusDocument(doc.playlistId),
			})),
		],
	};
}

export function listFileMenu(o: {
	onNew: () => void;
	onOpenList: () => void;
	quitItem: ClassicyMenuItem;
}): ClassicyMenuItem {
	return {
		id: "file",
		title: "File",
		menuChildren: [
			{ id: "playlist_file_new", title: "New", onClickFunc: o.onNew },
			{ id: "playlist_file_open", title: "Open", onClickFunc: o.onOpenList },
			SPACER,
			o.quitItem,
		],
	};
}

export function paletteFileMenu(o: {
	onOpenList: () => void;
	quitItem: ClassicyMenuItem;
}): ClassicyMenuItem {
	return {
		id: "file",
		title: "File",
		menuChildren: [
			{ id: "playlist_file_open", title: "Open", onClickFunc: o.onOpenList },
			SPACER,
			o.quitItem,
		],
	};
}
