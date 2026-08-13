import { ClassicyButton, ClassicyWindow } from "classicy";
import { useState } from "react";

export interface RenameDialogFormProps {
	initialTitle: string;
	onRename: (title: string) => void;
	onCancel: () => void;
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
export function RenameDialogForm({ initialTitle, onRename, onCancel }: RenameDialogFormProps) {
	const [title, setTitle] = useState(initialTitle);
	const trimmed = title.trim();

	return (
		<div className="playlistRenameDialog">
			<label>
				Title
				<input
					aria-label="Title"
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<ClassicyButton
				isDefault={true}
				// A blank title would leave the playlist unidentifiable in the
				// list window and in the Window menu.
				disabled={trimmed === ""}
				onClickFunc={() => {
					if (trimmed !== "") onRename(trimmed);
				}}
			>
				Rename
			</ClassicyButton>
			<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
		</div>
	);
}

export function RenameDialog({
	appId,
	icon,
	...formProps
}: RenameDialogFormProps & { appId: string; icon: string }) {
	return (
		<ClassicyWindow
			id="playlist_rename_dialog"
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
			<RenameDialogForm {...formProps} />
		</ClassicyWindow>
	);
}
