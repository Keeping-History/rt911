import type { ClassicyFileDialogEntry, ClassicyFileOpenSelection } from "classicy";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import { parsePlaylist } from "../../Providers/Playlist/parsePlaylist";
import type {
	MediaEntry,
	PlaylistDefinition,
	PlaylistEntry,
} from "../../Providers/Playlist/playlistTypes";
import { playlistUtcMs } from "../../Providers/Playlist/playlistTypes";
import { timelineBounds, type TimelineBounds } from "./timelineLayout";

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
	/** Playlist-level window (virtual-clock UTC ISO); see PlaylistDefinition. */
	start?: string;
	end?: string;
	entries: EditorEntry[];
	selectedUid: string | null;
	dirty: boolean;
	nextUid: number;
};

export type EditorAction =
	| { type: "load"; record: PlaylistRecord }
	| { type: "setTitle"; title: string }
	| { type: "renamed"; title: string }
	| { type: "setMode"; mode: "restrict" | "annotate" }
	| { type: "setWindow"; start?: string; end?: string }
	| { type: "setStatus"; status: "draft" | "published" }
	| {
			type: "addEntries";
			entries: { entry: PlaylistEntry; timelineMeta?: EditorEntry["timelineMeta"] }[];
			/** Select the last added entry, so the Settings window can edit it. */
			select?: boolean;
	  }
	| { type: "updateEntry"; uid: string; entry: PlaylistEntry }
	/**
	 * Give the media item behind `uid` another availability window: a new
	 * media entry for the same app + itemId, placed after the item's latest
	 * bound (see nextTimeWindow), selected so the Settings window edits it.
	 * The engine already reads several entries for one item as several
	 * windows (evaluate().isItemAvailable ORs them), so nothing else changes.
	 */
	| { type: "addTimeWindow"; uid: string }
	| { type: "removeEntry"; uid: string }
	| { type: "select"; uid: string | null }
	| { type: "markSaved" };

export function initialEditorState(record: PlaylistRecord): EditorState {
	const parsed = parsePlaylist(record.definition);
	if (parsed.warnings.length > 0) {
		console.warn("playlist-editor: definition warnings on load:", parsed.warnings);
	}
	const entries = (parsed.definition?.entries ?? []).map((entry, i) => ({
		uid: `e${i + 1}`,
		entry,
	}));
	return {
		playlistId: record.id,
		title: record.title,
		mode: parsed.definition?.mode ?? "annotate",
		status: record.status === "published" ? "published" : "draft",
		start: parsed.definition?.start,
		end: parsed.definition?.end,
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
		case "renamed":
			// Rename has ALREADY written the title to the server, so unlike
			// setTitle this must not mark the document dirty — that would make
			// the next Save re-send the whole definition, including edits the
			// user has not chosen to save yet.
			return { ...state, title: action.title };
		case "setMode":
			return { ...state, mode: action.mode, dirty: true };
		case "setWindow":
			// Both bounds together: the dialog edits them as one schedule, and a
			// partial update could not distinguish "leave alone" from "clear".
			return { ...state, start: action.start, end: action.end, dirty: true };
		case "setStatus":
			return { ...state, status: action.status, dirty: true };
		case "addEntries": {
			let next = state.nextUid;
			const added = action.entries.map((e) => ({
				uid: `e${next++}`,
				entry: e.entry,
				timelineMeta: e.timelineMeta,
			}));
			return {
				...state,
				entries: [...state.entries, ...added],
				nextUid: next,
				dirty: true,
				selectedUid:
					action.select && added.length > 0
						? added[added.length - 1].uid
						: state.selectedUid,
			};
		}
		case "updateEntry":
			return {
				...state,
				entries: state.entries.map((e) =>
					e.uid === action.uid ? { ...e, entry: action.entry } : e,
				),
				dirty: true,
			};
		case "addTimeWindow": {
			const source = state.entries.find((e) => e.uid === action.uid);
			if (!source || source.entry.kind !== "media") return state;
			const window = nextTimeWindow(
				state.entries,
				source.entry,
				timelineBounds(state.start, state.end),
			);
			// `focus` rides along: "the same item, again" almost always wants
			// the same behaviour, and the form the new entry opens in can change
			// it. Resolved metadata (a flight's actual span, a story's
			// publication time) rides along too, so the new bar draws right away
			// instead of waiting on another Directus lookup.
			const uid = `e${state.nextUid}`;
			return {
				...state,
				entries: [
					...state.entries,
					{
						uid,
						entry: { ...source.entry, start: window.start, end: window.end },
						timelineMeta: source.timelineMeta,
					},
				],
				nextUid: state.nextUid + 1,
				selectedUid: uid,
				dirty: true,
			};
		}
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

const WINDOW_DEFAULT_MS = 3_600_000;

/** Media entries that address the same item, by the engine's own rule (app + case-insensitive itemId). */
export function sameItemEntries(entries: EditorEntry[], item: MediaEntry): MediaEntry[] {
	const id = item.itemId.toLowerCase();
	return entries
		.map((e) => e.entry)
		.filter(
			(e): e is MediaEntry =>
				e.kind === "media" && e.app === item.app && e.itemId.toLowerCase() === id,
		);
}

/**
 * Where a NEW window for `item` goes by default: one hour, starting where the
 * item's latest bound ends — the greatest `end`, or the greatest `start` of a
 * window with no end, or the timeline's left edge when no window has any
 * bound — and clamped inside `bounds`. If an hour does not fit after the
 * anchor, the window ends at the right edge and starts an hour before it, so
 * the result is never inverted and never degenerate (bounds are whole hours,
 * at least one). The teacher then drags or types the real times.
 */
export function nextTimeWindow(
	entries: EditorEntry[],
	item: MediaEntry,
	bounds: TimelineBounds,
): { start: string; end: string } {
	let anchorMs = bounds.startMs;
	for (const e of sameItemEntries(entries, item)) {
		const bound = e.end ?? e.start;
		if (bound !== undefined) anchorMs = Math.max(anchorMs, playlistUtcMs(bound));
	}
	let startMs = Math.min(anchorMs, bounds.endMs);
	let endMs = startMs + WINDOW_DEFAULT_MS;
	if (endMs > bounds.endMs) {
		endMs = bounds.endMs;
		startMs = Math.max(bounds.startMs, endMs - WINDOW_DEFAULT_MS);
	}
	return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

export function assembleDefinition(state: EditorState): PlaylistDefinition {
	return {
		version: 1,
		mode: state.mode,
		...(state.start !== undefined ? { start: state.start } : {}),
		...(state.end !== undefined ? { end: state.end } : {}),
		entries: state.entries.map((e) => e.entry),
	};
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

function selectAllPathsOf(entry: ClassicyFileDialogEntry): string[][] | null {
	const paths = entry.meta?.selectAllPaths;
	return Array.isArray(paths) ? (paths as string[][]) : null;
}

/**
 * Resolves "Select All" pseudo-entries (meta.selectAllPaths, produced by the
 * archive volume in directusVolume.ts) into the file entries of the folders
 * they stand for, by re-listing those folders through the volume's own cached
 * list(). Plain selections pass through untouched. Media entries are deduped
 * by app+itemId within the batch, so picking "Select All" alongside one of the
 * items it covers doesn't add it twice.
 */
export async function expandSelections(
	selections: ClassicyFileOpenSelection[],
	listFolder: (path: string[]) => Promise<ClassicyFileDialogEntry[]>,
): Promise<{ entry: PlaylistEntry; timelineMeta?: EditorEntry["timelineMeta"] }[]> {
	const flat: ClassicyFileOpenSelection[] = [];
	for (const sel of selections) {
		const paths = selectAllPathsOf(sel.entry);
		if (!paths) {
			flat.push(sel);
			continue;
		}
		// Sequential on purpose: each list() call may hit Directus, and those
		// must stay serialized (see directusQueue.ts).
		for (const path of paths) {
			try {
				const items = await listFolder(path);
				for (const item of items) {
					// Folders and the folder's own Select All entry are not items.
					if (item.kind === "file" && !selectAllPathsOf(item)) {
						flat.push({ volumeId: sel.volumeId, path, entry: item });
					}
				}
			} catch (err) {
				console.warn(
					`playlist-editor: Select All listing failed for ${path.join("/")}:`,
					err,
				);
			}
		}
	}
	const seen = new Set<string>();
	return selectionsToEntries(flat).filter((e) => {
		if (e.entry.kind !== "media") return true;
		const key = `${e.entry.app} ${e.entry.itemId}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
