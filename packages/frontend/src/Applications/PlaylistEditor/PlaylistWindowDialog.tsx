import { ClassicyButton, ClassicyControlLabel, ClassicyWindow } from "classicy";
import { useState } from "react";
import { playlistUtcMs } from "../../Providers/Playlist/playlistTypes";
import { DateTimeField } from "./DateTimeField";

export interface PlaylistWindowDialogFormProps {
	initialStart: string | undefined;
	initialEnd: string | undefined;
	onSave: (window: { start?: string; end?: string }) => void;
	onCancel: () => void;
}

/**
 * Edits the playlist-level start/end window (see PlaylistDefinition.start).
 * Form split from the window shell, same shape as RenameDialogForm, so it is
 * testable without classicy window chrome.
 */
export function PlaylistWindowDialogForm({
	initialStart,
	initialEnd,
	onSave,
	onCancel,
}: PlaylistWindowDialogFormProps) {
	const [start, setStart] = useState<string | undefined>(initialStart);
	const [end, setEnd] = useState<string | undefined>(initialEnd);
	// The same rule parsePlaylist enforces (an inverted window would lock every
	// student out permanently) — caught here so it can't be saved at all.
	const inverted =
		start !== undefined && end !== undefined && playlistUtcMs(end) <= playlistUtcMs(start);

	return (
		<div className="playlistWindowDialog">
			<ClassicyControlLabel label="Limit this playlist to a time window. Outside it, no playlist content is available to students." />
			<DateTimeField
				label="Start"
				optional
				value={start}
				onChange={setStart}
				idPrefix="playlist-window-start"
			/>
			<DateTimeField
				label="End"
				optional
				value={end}
				onChange={setEnd}
				idPrefix="playlist-window-end"
			/>
			{inverted && <ClassicyControlLabel label="The end must be after the start." />}
			<ClassicyButton
				isDefault={true}
				disabled={inverted}
				onClickFunc={() => onSave({ start, end })}
			>
				OK
			</ClassicyButton>
			<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
		</div>
	);
}

export function PlaylistWindowDialog({
	appId,
	playlistId,
	icon,
	...formProps
}: PlaylistWindowDialogFormProps & { appId: string; playlistId: string; icon: string }) {
	return (
		<ClassicyWindow
			// Per playlist so switching the active document while a dialog is up
			// can never edit one playlist under another's store entry. Modal, so
			// classicy self-destroys the store entry on unmount.
			id={`playlist_window_${playlistId}`}
			appId={appId}
			title="Playlist Schedule"
			icon={icon}
			modal={true}
			closable={true}
			resizable={false}
			zoomable={false}
			collapsable={false}
			scrollable={false}
			initialSize={[340, 0]}
			initialPosition={[380, 200]}
			onCloseFunc={formProps.onCancel}
		>
			<PlaylistWindowDialogForm {...formProps} />
		</ClassicyWindow>
	);
}
