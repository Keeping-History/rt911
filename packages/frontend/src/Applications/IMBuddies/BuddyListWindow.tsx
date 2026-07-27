import { ClassicyButton, ClassicyWindow } from "classicy";
import type React from "react";
import { useMemo } from "react";
import type { ChatBuddy, ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import styles from "./IMBuddies.module.scss";
import { useIMBuddies } from "./IMBuddiesProvider";

// Same app id IMBuddiesProvider subscribes chat under — not exported from
// there, so it is repeated here rather than reached into (same call as
// SignOnWindow.tsx).
const APP_ID = "IMBuddies.app";

// The chat channel only ever exists 8 AM to midnight ET on September 11,
// 2001 (packages/backend/internal/chat/profile.go's WindowStart/WindowEnd,
// 12:00Z == 8:00 AM ET). That boundary is fixed for the life of this
// product, not something the server tells the client per-session, so it is
// a constant here rather than plumbed over the wire.
const CHAT_WINDOW_START_LABEL = "8:00 AM";

/**
 * Renders the one-sentence explanation for why chat is (or isn't) usable
 * right now. Pure and exported so the window itself never branches on
 * `reason` inline — it just renders whatever this returns.
 */
export function statusLineFor(reason: ChatStateReason, windowStartLabel: string): string {
	switch (reason) {
		case "outside_window":
			return `Nobody is online until ${windowStartLabel}.`;
		case "paused":
			return "Clock paused.";
		case "blocked":
			return "You can't send messages right now.";
		case "not_signed_in":
			return "Not signed on.";
		case "ok":
			return "Signed on.";
		default: {
			// Exhaustiveness guard: a sixth ChatStateReason added to the wire
			// protocol without a case added here fails this type check instead
			// of silently falling through to "Signed on.".
			const unhandled: never = reason;
			return unhandled;
		}
	}
}

/**
 * A buddy can be messaged only while online — the server refuses anyway, but
 * a UI that opens a dead window and then silently fails is worse than one
 * that never opens it. Shared by the double-click activation path and the IM
 * button's disabled state below so the two can't drift apart on a future edit.
 * Exported: the People menu's New Message item (Task 10) reuses this same
 * rule for its own disabled state rather than re-deriving it.
 *
 * Get Info deliberately does NOT use this: a profile is readable while its
 * owner is offline.
 */
export function isMessageable(buddy: ChatBuddy | null): buddy is ChatBuddy {
	return buddy !== null && buddy.online;
}

interface BuddyRowProps {
	buddy: ChatBuddy;
	selected: boolean;
	/** Messages from this buddy since their window was last read. 0 renders nothing. */
	unread: number;
	onSelect: (profile: number) => void;
	onActivate: (buddy: ChatBuddy) => void;
}

const BuddyRow: React.FC<BuddyRowProps> = ({ buddy, selected, unread, onSelect, onActivate }) => {
	const rowClass = [
		styles.buddyRow,
		buddy.online ? "" : styles.buddyRowOffline,
		selected ? styles.buddyRowSelected : "",
	]
		.filter(Boolean)
		.join(" ");
	const dotClass = [styles.buddyDot, buddy.online ? "" : styles.buddyDotOffline]
		.filter(Boolean)
		.join(" ");

	return (
		<div
			role="button"
			tabIndex={0}
			className={rowClass}
			onClick={() => onSelect(buddy.profile)}
			onDoubleClick={() => onActivate(buddy)}
			onKeyDown={(e) => {
				if (e.key !== "Enter") return;
				onSelect(buddy.profile);
				onActivate(buddy);
			}}
		>
			<span className={dotClass} aria-hidden="true" />
			<span>{buddy.screen_name}</span>
			{unread > 0 && (
				// AIM's own place for this. It is the ONLY signal that a message
				// arrived for a buddy whose window is closed — including a
				// server-initiated scheduled beat — since the sound assets for
				// IM_SOUNDS.receive are not shipped yet.
				<span className={styles.buddyUnread} title={`${unread} unread`}>
					{unread}
				</span>
			)}
		</div>
	);
};

export const BuddyListWindow: React.FC<{
	appMenu?: React.ComponentProps<typeof ClassicyWindow>["appMenu"];
}> = ({ appMenu }) => {
	const {
		buddies,
		reason,
		openChat,
		openInfoFor,
		conversationFor,
		selectedBuddy: selected,
		selectBuddy: setSelected,
	} = useIMBuddies();

	const { online, offline } = useMemo(() => {
		const online: ChatBuddy[] = [];
		const offline: ChatBuddy[] = [];
		for (const buddy of buddies) {
			(buddy.online ? online : offline).push(buddy);
		}
		return { online, offline };
	}, [buddies]);

	const activate = (buddy: ChatBuddy) => {
		if (!isMessageable(buddy)) return;
		openChat(buddy.profile);
	};

	const selectedBuddy = selected === null ? null : (buddies.find((b) => b.profile === selected) ?? null);
	// IM and Info answer different questions, so they take different gates —
	// the same split the People menu already makes. Messaging an offline buddy
	// opens a window the server will refuse, but READING a profile does not
	// require its owner to be online: knowing who a person is has nothing to do
	// with whether they are at their computer. Info only needs a selection.
	const imDisabled = !isMessageable(selectedBuddy);
	const infoDisabled = selectedBuddy === null;

	return (
		<ClassicyWindow
			id="im_buddylist"
			appId={APP_ID}
			title="Buddy List"
			// Closing puts the window away without signing off. The menu-bar
			// extension's Buddy List item reopens it -- see revealWindow in
			// IMBuddies.tsx, which must dispatch ClassicyWindowOpen and not
			// only ClassicyWindowFocus, or there is no way back from here.
			closable={true}
			resizable={true}
			zoomable={false}
			collapsable={true}
			initialSize={[150, 320]}
			initialPosition={["right", "top"]}
			appMenu={appMenu}
		>
			<div className={styles.buddyList}>
				<div className={styles.buddyGroups}>
					<div className={styles.buddyGroupHeader}>
						{`Buddies (${online.length}/${buddies.length})`}
					</div>
					{online.map((buddy) => (
						<BuddyRow
							key={buddy.profile}
							buddy={buddy}
							selected={selected === buddy.profile}
							unread={conversationFor(buddy.profile).unread}
							onSelect={setSelected}
							onActivate={activate}
						/>
					))}

					<div className={styles.buddyGroupHeader}>{`Offline (${offline.length})`}</div>
					{offline.map((buddy) => (
						<BuddyRow
							key={buddy.profile}
							buddy={buddy}
							selected={selected === buddy.profile}
							unread={conversationFor(buddy.profile).unread}
							onSelect={setSelected}
							onActivate={activate}
						/>
					))}
				</div>

				<div className={styles.buddyListActions}>
					<ClassicyButton
						buttonSize="small"
						disabled={imDisabled}
						onClickFunc={() => isMessageable(selectedBuddy) && openChat(selectedBuddy.profile)}
					>
						IM
					</ClassicyButton>
					<ClassicyButton
						buttonSize="small"
						disabled={infoDisabled}
						onClickFunc={() => selectedBuddy && openInfoFor(selectedBuddy.profile)}
					>
						Info
					</ClassicyButton>
				</div>

				<div className={styles.buddyListStatus}>
					{statusLineFor(reason, CHAT_WINDOW_START_LABEL)}
				</div>
			</div>
		</ClassicyWindow>
	);
};
