import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import { type EditorAction, editorReducer, type EditorState, initialEditorState } from "./editorState";

/** One `EditorState` per open document window, keyed by playlist id. */
export type EditorStates = Record<string, EditorState>;

export type EditorStatesAction =
	| { kind: "open"; record: PlaylistRecord }
	| { kind: "close"; playlistId: string }
	| { kind: "edit"; playlistId: string; action: EditorAction };

/**
 * Routes an `EditorAction` to one playlist's state and leaves every other
 * entry reference-identical, so opening a second playlist can never re-render
 * — or worse, reset — the first.
 *
 * `editorReducer`'s cases are deliberately untouched here: this wrapper owns only the
 * keying, which is why every existing `editorState.test.ts` case still holds.
 */
export function editorStatesReducer(
	states: EditorStates,
	action: EditorStatesAction,
): EditorStates {
	switch (action.kind) {
		case "open":
			// Already open: return the SAME object. Re-seeding from the record
			// would discard unsaved edits the moment a user picked an
			// already-open playlist out of the list again.
			if (states[action.record.id]) return states;
			return { ...states, [action.record.id]: initialEditorState(action.record) };
		case "close": {
			if (!states[action.playlistId]) return states;
			const next = { ...states };
			delete next[action.playlistId];
			return next;
		}
		case "edit": {
			const current = states[action.playlistId];
			if (!current) return states;
			return { ...states, [action.playlistId]: editorReducer(current, action.action) };
		}
	}
}
