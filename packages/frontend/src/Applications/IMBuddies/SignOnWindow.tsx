import {
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyInput,
	ClassicyPopUpMenu,
	ClassicySoundActionTypes,
	ClassicyWindow,
	useAppManagerDispatch,
	useSoundDispatch,
} from "classicy";
import type React from "react";
import { useCallback } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import styles from "./IMBuddies.module.scss";
import { useIMBuddies } from "./IMBuddiesProvider";
import { IM_SOUNDS } from "./sounds";

// Same app id IMBuddiesProvider subscribes chat under — not exported from
// there (this window doesn't need the rest of that module's surface), so it
// is repeated here rather than reached into.
const APP_ID = "IMBuddies.app";
const ACCOUNT_APP_ID = "Account.app";

// A fixed run of bullets. Nobody typed this, and — see the comment above the
// password field below — nothing ever reads it.
const FAKE_PASSWORD = "••••••••";

/**
 * Inline AIM "running man" mark. There is no art asset for this — the brief
 * is explicit that this is drawn, not fetched.
 */
const RunningManIcon: React.FC = () => (
	<svg
		className={styles.signOnLogo}
		viewBox="0 0 48 48"
		width={48}
		height={48}
		role="img"
		aria-label="AOL Instant Messenger"
		xmlns="http://www.w3.org/2000/svg"
	>
		<circle cx="24" cy="24" r="23" fill="#ffd400" stroke="#a67c00" strokeWidth="1.5" />
		<circle cx="24" cy="13" r="5" fill="#c02020" />
		<path
			d="M24 18 L18 27 L22 27 L19 38 L29 25 L24 25 L28 18 Z"
			fill="#c02020"
		/>
	</svg>
);

export const SignOnWindow: React.FC = () => {
	const { user } = useAuth();
	const { signOn } = useIMBuddies();
	const desktopEventDispatch = useAppManagerDispatch();
	const soundDispatch = useSoundDispatch();

	// The one place real credentials are handled: opening the Account app,
	// never authenticating here. Account.app is already registered (it's
	// mounted alongside every other app in Desktop.tsx), so name/icon below
	// are only ever used as a fallback for an app id that doesn't exist yet.
	const openAccountApp = useCallback(() => {
		desktopEventDispatch({
			type: "ClassicyAppOpen",
			app: { id: ACCOUNT_APP_ID, name: "Account", icon: "" },
		});
	}, [desktopEventDispatch]);

	const handleScreenNameChange = useCallback(
		(e: React.ChangeEvent<HTMLSelectElement>) => {
			if (e.target.value === "edit") openAccountApp();
		},
		[openAccountApp],
	);

	const handleSignOn = useCallback(() => {
		// Not signed in: there is no Directus session to subscribe chat under,
		// so Sign On hands off to the Account app instead of connecting.
		//
		// That fact is read from the local auth session, NOT from chatReason.
		// chatReason cannot answer it here: the streamer only ever emits
		// chat_state in reply to a `subscribe` (packages/backend/internal/
		// handler/ws.go, "subscribe" case), and the client only subscribes
		// after signOn() — so chatReason is still its "not_signed_in" initial
		// value at this moment for EVERY student, signed in or not. Gating on
		// it sent every student to the Account app and made signing on
		// impossible.
		if (!user) {
			openAccountApp();
			return;
		}
		signOn();
		soundDispatch({ type: ClassicySoundActionTypes.ClassicySoundPlay, sound: IM_SOUNDS.signOn });
	}, [user, signOn, openAccountApp, soundDispatch]);

	const screenName = user?.username ?? "";

	return (
		<ClassicyWindow
			id="im_signon"
			appId={APP_ID}
			title="Sign On"
			closable={true}
			resizable={false}
			zoomable={false}
			collapsable={false}
			initialSize={[280, 0]}
			initialPosition={["center", "center"]}
		>
			<div className={styles.signOn}>
				<div className={styles.signOnLogoRow}>
					<RunningManIcon />
				</div>

				{/*
				  A dropdown, AIM-style, because people had several screen names.
				  Here there is only ever one — the signed-in student's — plus an
				  Edit… item that hands off to the Account app, the one place a
				  screen name actually changes.
				*/}
				<ClassicyPopUpMenu
					id="im_signon_screenname"
					label="Screen Name:"
					labelPosition="left"
					options={[
						{ value: "screenname", label: screenName },
						{ value: "edit", label: "Edit…" },
					]}
					selected="screenname"
					onChangeFunc={handleScreenNameChange}
				/>

				{/*
				  Theatre. Renders bullets over a value nobody typed; nothing reads it and
				  nothing submits it. Authentication is the Directus session cookie the browser
				  already holds. Do not wire this to anything.
				*/}
				<ClassicyInput
					id="im_signon_password"
					labelTitle="Password"
					labelPosition="left"
					type="password"
					prefillValue={FAKE_PASSWORD}
					disabled={true}
				/>

				<div className={styles.signOnCheckboxes}>
					{/*
					  Inert period furniture, not merely visually so: with no disabled
					  prop, ClassicyCheckbox keeps its own useState seeded from
					  `checked` and flips it on every click regardless of onClickFunc
					  being absent — a student would watch "Save password" uncheck
					  itself with nothing reading or storing that. disabled=true is
					  load-bearing here, exactly like the password field above.
					*/}
					<ClassicyCheckbox
						id="im_signon_save_password"
						label="Save password"
						checked={true}
						disabled={true}
					/>
					<ClassicyCheckbox
						id="im_signon_auto_login"
						label="Auto-login"
						checked={false}
						disabled={true}
					/>
				</div>

				<div className={styles.signOnButtons}>
					{/*
					  Setup is the only real configuration this app has: the screen
					  name and the actual credentials both live in the Account app
					  (#322). Help used to sit beside it doing nothing at all and is
					  gone rather than disabled — see #328 for the Getting Started
					  stack that will bring it back with something to open.

					  Everything here is greyed out while signed out, except Sign On
					  itself, which is the way OUT of that state: it opens the
					  Account app. A window whose only working control is the one
					  that fixes the problem is clearer than one where every button
					  looks live and all but one silently fail.
					*/}
					<ClassicyButton onClickFunc={openAccountApp} buttonSize="small" disabled={!user}>
						Setup
					</ClassicyButton>
					<ClassicyButton isDefault={true} onClickFunc={handleSignOn}>
						{user ? "Sign On" : "Sign In"}
					</ClassicyButton>
				</div>
			</div>
		</ClassicyWindow>
	);
};
