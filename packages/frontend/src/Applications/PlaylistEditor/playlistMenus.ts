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
	onCopyStudentLink: () => void;
	quitItem: ClassicyMenuItem;
}

export const COPY_LINK_BALLOONS = {
	published:
		"Copies the address students use to join this playlist. Anyone with the " +
		"link can follow along — no sign-in needed.",
	draft:
		"Drafts aren't joinable. Set Status to Published (and Save) before " +
		"sharing a link with students.",
} as const;

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
			// Disabled-with-a-reason rather than hidden: a teacher looking for the
			// share affordance should find it, and the balloon says why a draft
			// can't be shared yet (loadPlaylist refuses unpublished playlists).
			{
				id: "playlist_file_copy_link",
				title: "Copy Student Link",
				disabled: o.status !== "published",
				balloon: {
					title: "Copy Student Link",
					content: COPY_LINK_BALLOONS[o.status],
				},
				onClickFunc: o.onCopyStudentLink,
			},
			SPACER,
			{ id: "playlist_file_delete", title: "Delete…", onClickFunc: o.onDelete },
			SPACER,
			o.quitItem,
		],
	};
}

export const ZOOM_BALLOON =
	"How much of the ten-day span the timeline shows at once. Zoom in to separate " +
	"entries that sit minutes apart; scroll sideways to move through time.";

export function documentViewMenu(o: {
	zoom: number;
	minZoom: number;
	maxZoom: number;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onActualSize: () => void;
}): ClassicyMenuItem {
	return {
		id: "view",
		title: "View",
		menuChildren: [
			{
				id: "playlist_view_zoom_in",
				title: "Zoom In",
				keyboardShortcut: "+",
				disabled: o.zoom >= o.maxZoom,
				balloon: { title: "Zoom In", content: ZOOM_BALLOON },
				onClickFunc: o.onZoomIn,
			},
			{
				id: "playlist_view_zoom_out",
				title: "Zoom Out",
				keyboardShortcut: "-",
				disabled: o.zoom <= o.minZoom,
				balloon: { title: "Zoom Out", content: ZOOM_BALLOON },
				onClickFunc: o.onZoomOut,
			},
			SPACER,
			{
				id: "playlist_view_actual_size",
				title: "Fit All Ten Days",
				// Already fitted is the checked state, not a disabled one: the item
				// reports where you are, and re-picking it is harmless.
				checked: o.zoom === o.minZoom,
				onClickFunc: o.onActualSize,
			},
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
export const SYNC_CLOCK_BALLOON =
	"Moves every student's clock to the time on your desktop right now. " +
	"One move — their clocks keep running on their own afterwards unless the clock is locked.";
export const SEND_MESSAGE_BALLOON =
	"Shows a short note on every student's desktop.";
export const FOCUS_APP_BALLOON =
	"Opens the chosen app and brings it to the front on every student's desktop.";
export const PUSH_UPDATE_BALLOONS = {
	ready:
		"Students re-load this playlist's latest saved version without leaving " +
		"the class. Use it after saving a mid-class edit.",
	dirty: "Save first — students can only receive what has been saved.",
	draft: "Only a published playlist can be followed by students.",
} as const;

/** The four playlist-app focus targets, in the order the submenu lists them.
 * Ids/names mirror Providers/Playlist/playlistApps.ts (PLAYLIST_APP_IDS /
 * APP_NAMES) — the same ids RoomControlBridge resolves on the student side. */
export const FOCUS_APPS: { appId: string; name: string }[] = [
	{ appId: "TV.app", name: "TV" },
	{ appId: "RadioTraffic.app", name: "Radio Traffic" },
	{ appId: "News.app", name: "News" },
	{ appId: "FlightTracker.app", name: "Flight Tracker" },
];

export function documentControlMenu(o: {
	lock: LockState;
	dirty: boolean;
	status: "draft" | "published";
	onToggleClock: () => void;
	onSyncClock: () => void;
	onSendMessage: () => void;
	onFocusApp: (appId: string) => void;
	onPushUpdate: () => void;
}): ClassicyMenuItem {
	// Push needs the students to be able to fetch what they're told to fetch:
	// unsaved edits aren't on the server, and a draft is refused by the
	// anonymous student loader. Dirty is the more actionable reason, so it wins
	// the balloon when both apply.
	const pushBlocked = o.dirty ? "dirty" : o.status !== "published" ? "draft" : null;
	return {
		id: "control",
		title: "Control",
		menuChildren: [
			{
				id: "playlist_control_sync",
				title: "Sync Students to My Clock",
				balloon: { title: "Sync Students to My Clock", content: SYNC_CLOCK_BALLOON },
				onClickFunc: o.onSyncClock,
			},
			{
				id: "playlist_control_focus",
				title: "Bring App to Front",
				balloon: { title: "Bring App to Front", content: FOCUS_APP_BALLOON },
				menuChildren: FOCUS_APPS.map((app) => ({
					id: `playlist_control_focus_${app.appId}`,
					title: app.name,
					onClickFunc: () => o.onFocusApp(app.appId),
				})),
			},
			{
				id: "playlist_control_message",
				title: "Send Message…",
				balloon: { title: "Send Message…", content: SEND_MESSAGE_BALLOON },
				onClickFunc: o.onSendMessage,
			},
			SPACER,
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
			SPACER,
			{
				id: "playlist_control_push",
				title: "Push Update to Class",
				disabled: pushBlocked !== null,
				balloon: {
					title: "Push Update to Class",
					content: PUSH_UPDATE_BALLOONS[pushBlocked ?? "ready"],
				},
				onClickFunc: o.onPushUpdate,
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
