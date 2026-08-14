import { ClassicyButton, ClassicyInput, ClassicyWindow } from "classicy";
import { useState } from "react";

export interface SendMessageDialogFormProps {
	onSend: (message: string) => void;
	onCancel: () => void;
	/** DOM id for the message field; must be per-playlist when several document
	 * windows can each mount this dialog. */
	inputId?: string;
}

/**
 * The teacher's "Send Message…" note to a class — delivered to every student
 * in the room as a `message` room command (see Providers/Playlist/roomApi.ts).
 *
 * Split from the window shell exactly like RenameDialog/RenameDialogForm so
 * the form is testable without classicy window chrome, and a window rather
 * than a ClassicyAlert for the same reason: an alert's contract is "only an
 * icon, text, and buttons", and this needs a text field.
 */
export function SendMessageDialogForm({
	onSend,
	onCancel,
	inputId = "playlist-send-message",
}: SendMessageDialogFormProps) {
	const [message, setMessage] = useState("");
	const trimmed = message.trim();
	// A blank note would pop an empty box on every student's desktop.
	const send = () => {
		if (trimmed !== "") onSend(trimmed);
	};

	return (
		<div className="playlistSendMessageDialog">
			<ClassicyInput
				id={inputId}
				labelTitle="Message"
				labelPosition="left"
				prefillValue=""
				onChangeFunc={(e) => setMessage(e.target.value)}
				onEnterFunc={send}
			/>
			<ClassicyButton isDefault={true} disabled={trimmed === ""} onClickFunc={send}>
				Send
			</ClassicyButton>
			<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
		</div>
	);
}

export function SendMessageDialog({
	appId,
	playlistId,
	icon,
	...formProps
}: SendMessageDialogFormProps & { appId: string; playlistId: string; icon: string }) {
	return (
		<ClassicyWindow
			// Per playlist, not a singleton — same store-collision reasoning as
			// RenameDialog: one of these can mount inside every document window.
			id={`playlist_send_message_${playlistId}`}
			appId={appId}
			title="Send Message to Class"
			icon={icon}
			modal={true}
			closable={true}
			resizable={false}
			zoomable={false}
			collapsable={false}
			scrollable={false}
			initialSize={[340, 0]}
			initialPosition={[400, 240]}
			onCloseFunc={formProps.onCancel}
		>
			<SendMessageDialogForm
				{...formProps}
				inputId={`playlist-send-message-${playlistId}`}
			/>
		</ClassicyWindow>
	);
}
