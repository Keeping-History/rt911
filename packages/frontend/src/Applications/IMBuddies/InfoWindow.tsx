import { ClassicyWindow } from "classicy";
import type React from "react";
import styles from "./IMBuddies.module.scss";
import { useIMBuddies } from "./IMBuddiesProvider";

// Same app id IMBuddiesProvider subscribes chat under — not exported from
// there, so it is repeated here rather than reached into (same call as
// ChatWindow.tsx/BuddyListWindow.tsx/SignOnWindow.tsx).
const APP_ID = "IMBuddies.app";

/**
 * AIM's "Get Info" panel: a small, read-only profile card for one buddy.
 *
 * `profile_text` is the ONLY student-facing bio field on ChatBuddy (Task 2).
 * There is no `persona` on the wire and never should be one here — persona is
 * a second-person instruction written FOR the language model ("You are
 * Danny, 13, eighth grade…"); showing it to a student would expose the
 * character's machinery. So when `profile_text` is empty or absent, this
 * renders the literal string "No profile." and stops there — it never falls
 * back to anything else.
 */
export const InfoWindow: React.FC<{ profile: number }> = ({ profile }) => {
	const { buddies, closeInfo } = useIMBuddies();
	const buddy = buddies.find((b) => b.profile === profile) ?? null;

	const screenName = buddy?.screen_name || "Buddy";
	const displayName = buddy?.display_name || "—";
	const online = buddy?.online ?? false;
	const profileText = buddy?.profile_text?.trim() ? buddy.profile_text : "No profile.";

	return (
		<ClassicyWindow
			// A STABLE id, deliberately not keyed on the profile: this is ONE
			// window that retargets to whichever buddy Get Info was last used on
			// (#325). Keying it on the profile would remount the window — it
			// would blink and jump back to its initial position — where a plain
			// re-render just swaps the contents, which is what retargeting
			// should feel like.
			id="im_info"
			appId={APP_ID}
			title={`Info: ${screenName}`}
			closable={true}
			resizable={false}
			zoomable={false}
			collapsable={true}
			initialSize={[220, 200]}
			initialPosition={["center", "center"]}
			onCloseFunc={closeInfo}
		>
			<div className={styles.infoWindow}>
				<div className={styles.infoRow}>
					<span className={styles.infoLabel}>Screen Name:</span> {screenName}
				</div>
				<div className={styles.infoRow}>
					<span className={styles.infoLabel}>Display Name:</span> {displayName}
				</div>
				<div className={styles.infoRow}>
					<span className={styles.infoLabel}>Status:</span> {online ? "Online" : "Offline"}
				</div>
				<div className={styles.infoProfile}>{profileText}</div>
			</div>
		</ClassicyWindow>
	);
};
