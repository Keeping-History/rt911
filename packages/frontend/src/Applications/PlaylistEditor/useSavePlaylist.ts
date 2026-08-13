import { useCallback, useState } from "react";
import { AuthRequiredError } from "../../Providers/Auth/authApi";
import { type PlaylistRecord, updatePlaylist } from "../../Providers/Auth/playlistApi";
import { parsePlaylist } from "../../Providers/Playlist/parsePlaylist";
import { assembleDefinition, type EditorState } from "./editorState";

/**
 * What the owning window should put on screen, if anything. The window renders
 * these as a ClassicyAlert; the hook itself renders nothing, which is what lets
 * File > Save, the dirty-close prompt, and Delete share one gate.
 */
export type SavePrompt =
	/** Nothing to show. */
	| { kind: "none" }
	/** A blocking message with a single OK. */
	| { kind: "message"; message: string }
	/** Validation would drop entries — blocked, with the reasons. */
	| { kind: "dropped"; warnings: string[] }
	/** Validation warned but dropped nothing — offer Save Anyway. */
	| { kind: "warnings"; warnings: string[] };

export function useSavePlaylist(
	state: EditorState,
	onSaved: (record: PlaylistRecord) => void,
	/** Injectable for tests; defaults to the real API call. */
	updateFn: typeof updatePlaylist = updatePlaylist,
) {
	const [prompt, setPrompt] = useState<SavePrompt>({ kind: "none" });
	const [saving, setSaving] = useState(false);

	const write = useCallback(async () => {
		setSaving(true);
		try {
			const record = await updateFn(state.playlistId, {
				title: state.title,
				definition: assembleDefinition(state),
				status: state.status,
			});
			setPrompt({ kind: "none" });
			onSaved(record);
		} catch (err) {
			setPrompt({
				kind: "message",
				message:
					err instanceof AuthRequiredError
						? "You've been signed out. Sign in via the Account app, then save again."
						: err instanceof Error
							? err.message
							: "Couldn't save.",
			});
		} finally {
			setSaving(false);
		}
	}, [state, onSaved, updateFn]);

	const save = useCallback(() => {
		const parsed = parsePlaylist(assembleDefinition(state));
		if (parsed.definition === null) {
			setPrompt({ kind: "message", message: "This playlist is invalid and can't be saved." });
			return;
		}
		// Dropped entries are not the same as warnings: saving the raw state
		// would silently lose them on next open, so block rather than offer
		// "Save Anyway".
		if (parsed.definition.entries.length < state.entries.length) {
			setPrompt({ kind: "dropped", warnings: parsed.warnings });
			return;
		}
		if (parsed.warnings.length > 0) {
			setPrompt({ kind: "warnings", warnings: parsed.warnings });
			return;
		}
		void write();
	}, [state, write]);

	const confirmSave = useCallback(() => void write(), [write]);
	const dismiss = useCallback(() => setPrompt({ kind: "none" }), []);

	return { prompt, save, confirmSave, dismiss, saving };
}
