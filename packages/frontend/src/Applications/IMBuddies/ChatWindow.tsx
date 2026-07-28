import {
	ClassicyButton,
	ClassicyInput,
	ClassicyWindow,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { virtualUtcMs } from "../../Providers/MediaStream/virtualClock";
import { composeGate } from "./composeGate";
import { EMOTICONS, renderEmoticons } from "./emoticons";
import styles from "./IMBuddies.module.scss";
import { useIMBuddies } from "./IMBuddiesProvider";

// Same app id IMBuddiesProvider subscribes chat under — not exported from
// there, so it is repeated here rather than reached into (same call as
// SignOnWindow.tsx/BuddyListWindow.tsx).
const APP_ID = "IMBuddies.app";

/**
 * How far each successive chat window is offset from the one before it, and
 * how many steps before the cascade restarts.
 *
 * Every window used to open at ["center", "center"], so the second buddy's
 * window landed pixel-perfect on the first and the app looked like it reused
 * one window for every conversation (#318). Cascading is what a Mac OS 8
 * desktop does, and it makes "one window per buddy" visible instead of merely
 * true. The wrap keeps a busy morning from walking windows off-screen.
 */
const CASCADE_STEP_PX = 24;
const CASCADE_WRAP = 6;

/**
 * Where the window for the `index`-th open conversation opens. Exported for
 * its own test: with everything centred this was invisible to every test that
 * rendered a single window, which is exactly how #318 shipped.
 */
export function cascadePosition(index: number): [number, number] {
	const step = (index % CASCADE_WRAP) * CASCADE_STEP_PX;
	return [40 + step, 40 + step];
}

export const ChatWindow: React.FC<{
	profile: number;
	index?: number;
	appMenu?: React.ComponentProps<typeof ClassicyWindow>["appMenu"];
}> = ({ profile, index = 0, appMenu }) => {
	const {
		buddies,
		conversationFor,
		lastMessageAtFor,
		typingProfile,
		send,
		markRead,
		closeChat,
		enabled,
		reason,
	} = useIMBuddies();

	const desktopEventDispatch = useAppManagerDispatch();
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

	// Take focus when this window first appears (#324): raise it above whatever
	// it cascaded on top of, and put the cursor straight in the compose field,
	// because typing is the only reason to open a chat.
	//
	// Mount-only, deliberately. Focus follows the STUDENT's action, never the
	// server's — a buddy replying in a background window must not rip the cursor
	// out of the window they are typing in. That is what the unread badge and
	// the receive sound are for. The already-open case (pressing IM for a buddy
	// whose window exists) is handled in the provider's openChat, which is the
	// only side that can see it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by
	// design; re-running on profile/appId change would be a focus steal.
	useEffect(() => {
		desktopEventDispatch({
			type: "ClassicyWindowFocus",
			app: { id: APP_ID },
			window: { id: `im_chat_${profile}` },
		});
		document.getElementById(`im_chat_input_${profile}`)?.focus();
	}, []);

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

	// This window reads the clock itself rather than taking it from the provider.
	// Two reasons: IMBuddiesProvider deliberately keeps localDate out of its
	// context value so that value is not rebuilt once a second for every
	// consumer, and the per-second re-render is exactly what re-enables the
	// composer the moment the clock reaches the conversation again.
	// virtualUtcMs strips the display offset back off (hard rule 3).
	const { localDate, tzOffset } = useClassicyDateTime({ tick: true });
	const { enabled: composeEnabled, hint, placeholder } = composeGate({
		serverEnabled: enabled,
		reason,
		lastMessageAtMs: lastMessageAtFor(profile),
		nowMs: virtualUtcMs(localDate, tzOffset),
		tzOffsetHours: tzOffset,
	});

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
			initialPosition={cascadePosition(index)}
			onCloseFunc={() => closeChat(profile)}
			appMenu={appMenu}
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
									disabled={!composeEnabled}
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
							disabled={!composeEnabled}
							onClickFunc={() => setPickerOpen((prev) => !prev)}
						>
							:-)
						</ClassicyButton>
						<ClassicyInput
							id={`im_chat_input_${profile}`}
							prefillValue={text}
							placeholder={placeholder}
							disabled={!composeEnabled}
							onChangeFunc={(e) => setText(e.target.value)}
							onEnterFunc={handleSend}
						/>
						<ClassicyButton isDefault={true} disabled={!composeEnabled} onClickFunc={handleSend}>
							Send
						</ClassicyButton>
					</div>
					{hint && <div className={styles.chatComposeHint}>{hint}</div>}
				</div>
			</div>
		</ClassicyWindow>
	);
};
