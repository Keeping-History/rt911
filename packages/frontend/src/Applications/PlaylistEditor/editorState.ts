import type { ClassicyFileOpenSelection } from "classicy";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import { parsePlaylist } from "../../Providers/Playlist/parsePlaylist";
import type {
	PlaylistDefinition,
	PlaylistEntry,
} from "../../Providers/Playlist/playlistTypes";
import { playlistUtcMs } from "../../Providers/Playlist/playlistTypes";

export const DISPLAY_TZ_OFFSET_HOURS = -4;

export type EditorEntry = {
	uid: string;
	entry: PlaylistEntry;
	timelineMeta?: {
		publishedAt?: string | null;
		departure?: string | null;
		arrival?: string | null;
	};
};

export type EditorState = {
	playlistId: string;
	title: string;
	mode: "restrict" | "annotate";
	status: "draft" | "published";
	entries: EditorEntry[];
	selectedUid: string | null;
	dirty: boolean;
	nextUid: number;
};

export type EditorAction =
	| { type: "load"; record: PlaylistRecord }
	| { type: "setTitle"; title: string }
	| { type: "setMode"; mode: "restrict" | "annotate" }
	| { type: "setStatus"; status: "draft" | "published" }
	| {
			type: "addEntries";
			entries: { entry: PlaylistEntry; timelineMeta?: EditorEntry["timelineMeta"] }[];
	  }
	| { type: "updateEntry"; uid: string; entry: PlaylistEntry }
	| { type: "removeEntry"; uid: string }
	| { type: "select"; uid: string | null }
	| { type: "markSaved" };

export function initialEditorState(record: PlaylistRecord): EditorState {
	const parsed = parsePlaylist(record.definition);
	const entries = (parsed.definition?.entries ?? []).map((entry, i) => ({
		uid: `e${i + 1}`,
		entry,
	}));
	return {
		playlistId: record.id,
		title: record.title,
		mode: parsed.definition?.mode ?? "annotate",
		status: record.status === "published" ? "published" : "draft",
		entries,
		selectedUid: null,
		dirty: false,
		nextUid: entries.length + 1,
	};
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
	switch (action.type) {
		case "load":
			return initialEditorState(action.record);
		case "setTitle":
			return { ...state, title: action.title, dirty: true };
		case "setMode":
			return { ...state, mode: action.mode, dirty: true };
		case "setStatus":
			return { ...state, status: action.status, dirty: true };
		case "addEntries": {
			let next = state.nextUid;
			const added = action.entries.map((e) => ({
				uid: `e${next++}`,
				entry: e.entry,
				timelineMeta: e.timelineMeta,
			}));
			return { ...state, entries: [...state.entries, ...added], nextUid: next, dirty: true };
		}
		case "updateEntry":
			return {
				...state,
				entries: state.entries.map((e) =>
					e.uid === action.uid ? { ...e, entry: action.entry } : e,
				),
				dirty: true,
			};
		case "removeEntry":
			return {
				...state,
				entries: state.entries.filter((e) => e.uid !== action.uid),
				selectedUid: state.selectedUid === action.uid ? null : state.selectedUid,
				dirty: true,
			};
		case "select":
			return { ...state, selectedUid: action.uid };
		case "markSaved":
			return { ...state, dirty: false };
	}
}

export function assembleDefinition(state: EditorState): PlaylistDefinition {
	return { version: 1, mode: state.mode, entries: state.entries.map((e) => e.entry) };
}

export function displayWallClockToUtcIso(d: Date): string {
	const utcMs =
		Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) -
		DISPLAY_TZ_OFFSET_HOURS * 3600_000;
	return new Date(utcMs).toISOString();
}

export function utcIsoToDisplayWallClock(iso: string): Date {
	const displayMs = playlistUtcMs(iso) + DISPLAY_TZ_OFFSET_HOURS * 3600_000;
	const u = new Date(displayMs);
	return new Date(
		u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
		u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds(),
	);
}

export function selectionsToEntries(
	selections: ClassicyFileOpenSelection[],
): { entry: PlaylistEntry; timelineMeta?: EditorEntry["timelineMeta"] }[] {
	return selections.flatMap((sel) => {
		const meta = sel.entry.meta ?? {};
		if (typeof meta.app === "string" && typeof meta.itemId === "string") {
			const timelineMeta: EditorEntry["timelineMeta"] = {};
			if ("publishedAt" in meta) timelineMeta.publishedAt = meta.publishedAt as string | null;
			if ("departure" in meta) timelineMeta.departure = meta.departure as string | null;
			if ("arrival" in meta) timelineMeta.arrival = meta.arrival as string | null;
			return [{
				entry: {
					kind: "media",
					app: meta.app as "tv" | "radio" | "news" | "flights",
					itemId: meta.itemId,
				} as PlaylistEntry,
				timelineMeta: Object.keys(timelineMeta).length > 0 ? timelineMeta : undefined,
			}];
		}
		if (typeof meta.classicyPath === "string") {
			return [{ entry: { kind: "file", path: meta.classicyPath, at: "" } as PlaylistEntry }];
		}
		return [];
	});
}
