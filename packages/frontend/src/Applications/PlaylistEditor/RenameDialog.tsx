import { ClassicyButton, ClassicyInput, ClassicyWindow } from "classicy";
import { useState } from "react";

export interface RenameDialogFormProps {
	initialTitle: string;
	onRename: (title: string) => void;
	onCancel: () => void;
	/** DOM id for the title field; must be per-playlist when several document
	 * windows can each mount a rename dialog. */
	inputId?: string;
}

/**
 * Split from the window shell (the same shape as TimeMachine's
 * BookmarkDialog/BookmarkDialogForm) so the form is testable without classicy
 * window chrome.
 *
 * This is a window rather than a ClassicyAlert because an alert's contract is
 * explicitly "only an icon, text, and buttons — no other controls", and this
 * needs a text field.
 */
export function RenameDialogForm({
	initialTitle,
	onRename,
	onCancel,
	inputId = "playlist-rename-title",
}: RenameDialogFormProps) {
	const [title, setTitle] = useState(initialTitle);
	const trimmed = title.trim();
	// A blank title would leave the playlist unidentifiable in the list window
	// and in the Window menu.
	const rename = () => {
		if (trimmed !== "") onRename(trimmed);
	};

	return (
		<div className="playlistRenameDialog">
			<ClassicyInput
				id={inputId}
				labelTitle="Title"
				labelPosition="left"
				prefillValue={initialTitle}
				onChangeFunc={(e) => setTitle(e.target.value)}
				onEnterFunc={rename}
			/>
			<ClassicyButton isDefault={true} disabled={trimmed === ""} onClickFunc={rename}>
				Rename
			</ClassicyButton>
			<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
		</div>
	);
}

export function RenameDialog({
	appId,
	playlistId,
	icon,
	...formProps
}: RenameDialogFormProps & { appId: string; playlistId: string; icon: string }) {
	return (
		<ClassicyWindow
			// Per playlist, not a singleton: one of these is rendered inside
			// every document window, so a shared id would let two simultaneous
			// renames collide in the store — and the first to unmount would
			// destroy the other's entry with it.
			id={`playlist_rename_${playlistId}`}
			appId={appId}
			title="Rename Playlist"
			icon={icon}
			modal={true}
			closable={true}
			resizable={false}
			zoomable={false}
			collapsable={false}
			scrollable={false}
			initialSize={[300, 0]}
			initialPosition={[400, 240]}
			onCloseFunc={formProps.onCancel}
		>
			<RenameDialogForm {...formProps} inputId={`playlist-rename-title-${playlistId}`} />
		</ClassicyWindow>
	);
}
