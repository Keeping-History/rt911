import { ClassicyButton, ClassicyInput, ClassicyWindow } from "classicy";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import { EMOTICONS, renderEmoticons } from "./emoticons";
import styles from "./IMBuddies.module.scss";
import { useIMBuddies } from "./IMBuddiesProvider";

// Same app id IMBuddiesProvider subscribes chat under — not exported from
// there, so it is repeated here rather than reached into (same call as
// SignOnWindow.tsx/BuddyListWindow.tsx).
const APP_ID = "IMBuddies.app";

/**
 * Renders the one-sentence explanation for why compose is (or isn't) usable
 * right now. Pure and exported so the window itself never branches on
 * `reason` inline — it just renders whatever this returns. Unlike
 * BuddyListWindow's statusLineFor, "ok" has no news to report: an empty
 * string means the compose row simply isn't showing a hint.
 */
export function composeHintFor(reason: ChatStateReason): string {
	switch (reason) {
		case "paused":
			return "Start the clock to keep talking.";
		case "outside_window":
			return "Nobody is online right now.";
		case "blocked":
			return "You can't send messages right now.";
		case "not_signed_in":
			return "Sign on to send messages.";
		case "ok":
			return "";
		default: {
			// Exhaustiveness guard: a sixth ChatStateReason added to the wire
			// protocol without a case added here fails this type check instead
			// of silently rendering nothing.
			const unhandled: never = reason;
			return unhandled;
		}
	}
}

export const ChatWindow: React.FC<{ profile: number }> = ({ profile }) => {
	const { buddies, conversationFor, typingProfile, send, markRead, closeChat, enabled, reason } =
		useIMBuddies();

	const [text, setText] = useState("");
	const [pickerOpen, setPickerOpen] = useState(false);
	const transcriptRef = useRef<HTMLDivElement | null>(null);

	const buddy = buddies.find((b) => b.profile === profile) ?? null;
	const name = buddy?.display_name || buddy?.screen_name || "Buddy";

	const { messages } = conversationFor(profile);

	// Everything visible in an OPEN chat window counts as read, not just what
	// was there the moment it was opened — a message arriving while the
	// student is already looking at this window must not leave a stray
	// unread badge on the Buddy List behind it.
	useEffect(() => {
		markRead(profile);
	}, [messages, profile, markRead]);

	useEffect(() => {
		const el = transcriptRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	const handleSend = useCallback(() => {
		const trimmed = text.trim();
		// A keystroke that does nothing must not chirp -- bail before the wire
		// call for an empty/whitespace-only field. The send sound itself is
		// the provider's responsibility (IMBuddiesProvider.send already plays
		// IM_SOUNDS.send) — playing it here too would chirp twice per message.
		if (!trimmed) return;
		send(profile, trimmed);
		setText("");
	}, [text, send, profile]);

	const insertEmoticon = useCallback((token: string) => {
		setText((prev) => (prev.length === 0 || prev.endsWith(" ") ? `${prev}${token}` : `${prev} ${token}`));
		setPickerOpen(false);
	}, []);

	const hint = composeHintFor(reason);

	return (
		<ClassicyWindow
			id={`im_chat_${profile}`}
			appId={APP_ID}
			title={name}
			closable={true}
			resizable={true}
			zoomable={false}
			collapsable={true}
			initialSize={[260, 320]}
			initialPosition={["center", "center"]}
			onCloseFunc={() => closeChat(profile)}
		>
			<div className={styles.chatWindow}>
				<div className={styles.chatTranscript} ref={transcriptRef}>
					{messages.map((message, index) => {
						// A kind:"stall" message (queue-full, the backend's
						// in-character "hang on, phones ringing") is rendered
						// exactly like any other buddy line, deliberately: it is
						// meant to read as the buddy speaking, not as an error.
						const speaker = message.direction === "out" ? name : "You";
						return (
							<div className={styles.chatMessage} key={`${message.message_id}-${index}`}>
								<span className={styles.chatMessageName}>{speaker}: </span>
								<span>{renderEmoticons(message.body)}</span>
							</div>
						);
					})}
				</div>

				{typingProfile === profile && (
					<div className={styles.chatTyping}>{`${name} is typing...`}</div>
				)}

				<div className={styles.chatCompose}>
					{pickerOpen && (
						<div className={styles.chatEmoticonPicker}>
							{EMOTICONS.map(([token]) => (
								<ClassicyButton
									key={token}
									buttonSize="small"
									disabled={!enabled}
									onClickFunc={() => insertEmoticon(token)}
								>
									{renderEmoticons(token)}
								</ClassicyButton>
							))}
						</div>
					)}
					<div className={styles.chatComposeRow}>
						<ClassicyButton
							buttonSize="small"
							disabled={!enabled}
							onClickFunc={() => setPickerOpen((prev) => !prev)}
						>
							:-)
						</ClassicyButton>
						<ClassicyInput
							id={`im_chat_input_${profile}`}
							prefillValue={text}
							placeholder={hint || "Type a message"}
							disabled={!enabled}
							onChangeFunc={(e) => setText(e.target.value)}
							onEnterFunc={handleSend}
						/>
						<ClassicyButton isDefault={true} disabled={!enabled} onClickFunc={handleSend}>
							Send
						</ClassicyButton>
					</div>
					{hint && <div className={styles.chatComposeHint}>{hint}</div>}
				</div>
			</div>
		</ClassicyWindow>
	);
};
