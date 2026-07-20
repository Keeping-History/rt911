import { ClassicyButton } from "classicy";
import { useState } from "react";
import { AuthRequiredError } from "../../Providers/Auth/authApi";
import { type PlaylistRecord, updatePlaylist } from "../../Providers/Auth/playlistApi";
import { parsePlaylist } from "../../Providers/Playlist/parsePlaylist";
import { assembleDefinition, type EditorState } from "./editorState";

export function SaveBar({
	state,
	onSaved,
	warningCancelLabel = "Don't Save",
}: {
	state: EditorState;
	onSaved: (record: PlaylistRecord) => void;
	/**
	 * Label for the button that dismisses the warnings list and returns to the
	 * plain Save button (does NOT quit or navigate anywhere). Defaults to
	 * "Don't Save"; callers embedding SaveBar next to their own "Don't Save"
	 * action (e.g. the dirty-close strip's quit-without-saving button) should
	 * pass something else — e.g. "Keep Editing" — to avoid two same-labeled
	 * buttons with different behavior.
	 */
	warningCancelLabel?: string;
}) {
	const [message, setMessage] = useState<string | null>(null);
	const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);
	const [droppedWarnings, setDroppedWarnings] = useState<string[] | null>(null);

	const write = async () => {
		try {
			const def = assembleDefinition(state);
			const record = await updatePlaylist(state.playlistId, {
				title: state.title,
				definition: def,
				status: state.status,
			});
			setMessage(null);
			setPendingWarnings(null);
			onSaved(record);
		} catch (err) {
			if (err instanceof AuthRequiredError) {
				setMessage("You've been signed out. Sign in via the Account app, then save again.");
			} else {
				setMessage(err instanceof Error ? err.message : "Couldn't save.");
			}
		}
	};

	const save = () => {
		setMessage(null);
		setDroppedWarnings(null);
		const def = assembleDefinition(state);
		const parsed = parsePlaylist(def);
		if (parsed.definition === null) {
			setMessage("This playlist is invalid and can't be saved.");
			return;
		}
		if (parsed.definition.entries.length < state.entries.length) {
			// Some entries were dropped (not merely warned-about) during
			// validation — saving the raw state would silently lose them on
			// next open, so block outright rather than offering Save Anyway.
			setMessage("Some entries are incomplete and would be lost — fix them before saving.");
			setDroppedWarnings(parsed.warnings);
			return;
		}
		if (parsed.warnings.length > 0) {
			setPendingWarnings(parsed.warnings);
			return;
		}
		void write();
	};

	return (
		<div className="playlistSaveBar">
			{message && <p className="playlistSaveMessage">{message}</p>}
			{droppedWarnings ? (
				<>
					<ul className="playlistSaveWarnings">
						{droppedWarnings.map((w) => <li key={w}>{w}</li>)}
					</ul>
					<ClassicyButton
						onClickFunc={() => {
							setMessage(null);
							setDroppedWarnings(null);
						}}
					>
						OK
					</ClassicyButton>
				</>
			) : pendingWarnings ? (
				<>
					<ul className="playlistSaveWarnings">
						{pendingWarnings.map((w) => <li key={w}>{w}</li>)}
					</ul>
					<ClassicyButton onClickFunc={() => void write()}>Save Anyway</ClassicyButton>
					<ClassicyButton onClickFunc={() => setPendingWarnings(null)}>{warningCancelLabel}</ClassicyButton>
				</>
			) : (
				<ClassicyButton isDefault={true} disabled={!state.dirty} onClickFunc={save}>
					Save
				</ClassicyButton>
			)}
		</div>
	);
}
