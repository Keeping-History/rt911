import {
	ClassicyAlert,
	ClassicyApp,
	ClassicyIcons,
	ClassicyMenuBarExtension,
	type ClassicyMenuItem,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
	useAppManagerDispatch,
} from "classicy";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import appIconPng from "./app.png";
import { BuddyListWindow, isMessageable } from "./BuddyListWindow";
import { ChatWindow } from "./ChatWindow";
import styles from "./IMBuddies.module.scss";
import { IMBuddiesProvider, useIMBuddies } from "./IMBuddiesProvider";
import { InfoWindow } from "./InfoWindow";
import { SignOnWindow } from "./SignOnWindow";

const APP_ID = "IMBuddies.app";
const APP_NAME = "Instant Messenger";

// This app's own icon, registered into the shared registry (same pattern as
// TimeMachine.tsx). Art is a placeholder — see the brief.
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		imBuddies: { app: appIconPng },
	},
});
const appIcon = ICONS.applications.imBuddies.app;

const BUDDY_LIST_WINDOW_ID = "im_buddylist";

/**
 * The File menu every non-utility IM Buddies window carries, so Quit is where
 * a Mac user reaches for it. Module-level rather than a useMemo: it closes
 * over nothing but module constants, so there is no dependency that could
 * change and no render it needs to be recomputed on.
 *
 * Quit also remains in the menu-bar extension below. That duplication is
 * deliberate — the tray item shipped first and users may already know it.
 *
 * Deliberately NOT passed to InfoWindow: it is a utility window, and
 * classicy's focus reducer only assigns Desktop.appMenu when the focused
 * window supplies one, so a menu-less Get Info leaves this File menu on
 * screen rather than blanking the menu bar.
 */
const APP_MENU: ClassicyMenuItem[] = [
	{
		id: "file",
		title: "File",
		menuChildren: [quitMenuItemHelper(APP_ID, APP_NAME, appIcon)],
	},
];
// The one app that handles real credentials — the same id SignOnWindow hands
// off to when there is no Directus session.
const ACCOUNT_APP_ID = "Account.app";

/**
 * People and Window menus, plus Quit. `ClassicyMenuBarExtension` portal-
 * renders its button into the desktop's menu-bar-extensions tray rather than
 * the File/Edit-style `appMenu` every other app passes to `ClassicyWindow` —
 * unlike that, nothing about the component itself hides it when another app
 * is frontmost, so this component is only ever MOUNTED while IM Buddies is
 * the focused app (see IMBuddiesContent below); an app's own menus belong to
 * the frontmost app, exactly like Mac OS 8's File/Edit menus, and only
 * status extras are meant to be permanent.
 *
 * Lives inside IMBuddiesProvider (unlike the ClassicyApp wrapper further up
 * the tree) because it reads useIMBuddies() for the Window list and the
 * current Buddy List selection.
 */
const IMBuddiesMenus: React.FC = () => {
	const { connected, buddies, openChats, openChat, openInfoFor, selectedBuddy, signOff } =
		useIMBuddies();
	const desktopEventDispatch = useAppManagerDispatch();

	const focusWindow = useCallback(
		(windowId: string) =>
			desktopEventDispatch({
				type: "ClassicyWindowFocus",
				app: { id: APP_ID },
				window: { id: windowId },
			}),
		[desktopEventDispatch],
	);

	// The buddy highlighted in the Buddy List, if any -- looked up fresh each
	// render (not cached) since `selectedBuddy` is just a profile id.
	const selectedBuddyObj = useMemo(
		() => buddies.find((b) => b.profile === selectedBuddy) ?? null,
		[buddies, selectedBuddy],
	);

	// ONE menu, not two (#323). People and Window were separate extensions with
	// text titles, which put two words of chrome in the menu bar for a single
	// app -- and a menu-bar extension is the icon-sized slot on the right, where
	// words read as the wrong kind of thing. Merged with a separator between the
	// people actions and the window list, the way a Mac OS 8 menu groups.
	//
	// Rebuilt fresh every render from openChats/buddies -- never snapshotted --
	// so a chat window opening or closing is reflected in the very same render
	// that adds/removes its <ChatWindow> below, not a stale copy from whenever
	// this menu last happened to re-run.
	const menuItems = useMemo<ClassicyMenuItem[]>(() => {
		const items: ClassicyMenuItem[] = [
			{
				id: "im_menu_new_message",
				title: "New Message",
				// Same rule the Buddy List's own IM button enforces (isMessageable):
				// an offline buddy can't be messaged, so there's nothing to open.
				disabled: !connected || !isMessageable(selectedBuddyObj),
				onClickFunc: () => {
					if (isMessageable(selectedBuddyObj)) openChat(selectedBuddyObj.profile);
				},
			},
			{
				id: "im_menu_get_info",
				title: "Get Info",
				// Unlike New Message, an offline buddy's profile is still readable --
				// only "nothing selected" disables this one.
				disabled: !connected || selectedBuddyObj === null,
				onClickFunc: () => {
					if (selectedBuddyObj) openInfoFor(selectedBuddyObj.profile);
				},
			},
			{
				id: "im_menu_sign_off",
				title: "Sign Off",
				disabled: !connected,
				onClickFunc: signOff,
			},
			quitMenuItemHelper(APP_ID, APP_NAME, appIcon),
			// classicy renders an item whose id is "spacer" as an <hr> rather
			// than a row — that is the library's separator convention, not a
			// placeholder id.
			{ id: "spacer" },
			{
				id: "im_menu_buddylist",
				title: "Buddy List",
				disabled: !connected,
				onClickFunc: () => focusWindow(BUDDY_LIST_WINDOW_ID),
			},
		];
		for (const profile of openChats) {
			const buddy = buddies.find((b) => b.profile === profile);
			const name = buddy?.display_name || buddy?.screen_name || `Buddy ${profile}`;
			items.push({
				id: `im_menu_window_${profile}`,
				title: name,
				onClickFunc: () => focusWindow(`im_chat_${profile}`),
			});
		}
		return items;
	}, [connected, selectedBuddyObj, openChat, openInfoFor, signOff, openChats, buddies, focusWindow]);

	return (
		<ClassicyMenuBarExtension id="im_menu" order={1} title={APP_NAME} menuItems={menuItems}>
			{/* Icon only — the title above is what names it to a screen reader. */}
			<img src={appIcon} alt={APP_NAME} className={styles.menuBarIcon} />
		</ClassicyMenuBarExtension>
	);
};

/**
 * Sign On while disconnected, Buddy List once connected, one Chat window per
 * entry in openChats, and a single retargeting Info window -- all mapped live
 * off provider state, never a fixed "all buddies" list, so a closed
 * conversation's window actually disappears instead of just losing focus.
 */
const IMBuddiesContent: React.FC = () => {
	const { connected, openChats, infoProfile } = useIMBuddies();
	const { user } = useAuth();
	const desktopEventDispatch = useAppManagerDispatch();
	// Same selector idiom as PlaylistProvider.tsx: read app-manager state
	// directly rather than plumbing a prop. IMBuddiesMenus is only ever
	// mounted while this app is the frontmost one -- see the comment on that
	// component for why that matters.
	const isFrontmost = useAppManager(
		(s) => s.System.Manager.Applications.focusedAppId === APP_ID,
	);

	// Shown once per app open while signed out, then dismissed. ClassicyApp
	// renders its children only while the app is open, so this component
	// mounting IS the app opening and the state resets on the next open -- no
	// separate "have I shown this yet" bookkeeping to go stale.
	const [signInAlertDismissed, setSignInAlertDismissed] = useState(false);

	return (
		<>
			{isFrontmost && <IMBuddiesMenus />}
			{/*
			  Signed out, this app cannot do anything at all: chat identity is the
			  Directus session cookie, so the streamer refuses every send no
			  matter what the student does here. Say so up front rather than
			  letting them press Sign On and quietly land in a different app.
			  Quit and Sign In are the only two real options, so they are the
			  only two buttons.
			*/}
			{!user && !signInAlertDismissed && (
				<ClassicyAlert
					id="im_signin_required"
					appId={APP_ID}
					alertType="stop"
					title={APP_NAME}
					label="You must be signed in to use Instant Messenger."
					message="Your buddies need to know who they are talking to. Sign in with the Account app, then come back."
					buttons={[
						{
							id: "im_signin_required_quit",
							label: "Quit",
							role: "cancel",
							onClick: () =>
								desktopEventDispatch({
									type: "ClassicyAppClose",
									app: { id: APP_ID, name: APP_NAME, icon: appIcon },
								}),
						},
						{
							id: "im_signin_required_signin",
							label: "Sign In",
							role: "default",
							onClick: () =>
								desktopEventDispatch({
									type: "ClassicyAppOpen",
									app: { id: ACCOUNT_APP_ID, name: "Account", icon: "" },
								}),
						},
					]}
					onClose={() => setSignInAlertDismissed(true)}
				/>
			)}
			{!connected && <SignOnWindow appMenu={APP_MENU} />}
			{/*
			  Every window below the Sign On window is gated on `connected` too,
			  not just the Buddy List. A dropped socket flips `connected` false
			  (that is what CRITICAL 1's derivation bought) while openChats /
			  infoProfile are cleared only by signOff — so without this gate a
			  student would be left looking at chat windows sitting beside the
			  Sign On window, on top of a conversation they can no longer
			  continue. The lists themselves are kept, so a recovered socket
			  restores the same windows rather than dumping the session.
			*/}
			{connected && (
				<>
					<BuddyListWindow />
					{openChats.map((profile, i) => (
						// `i` drives the cascade offset (#318). Windows used to
						// open centred, one exactly on top of the last, which
						// read as a single window being reused for every buddy.
						<ChatWindow key={profile} profile={profile} index={i} />
					))}
					{/*
					  ONE Get Info window, retargeted to the buddy Get Info was
					  last used on rather than one window per buddy (#325) — see
					  IMBuddiesProvider.openInfoFor.
					*/}
					{infoProfile !== null && <InfoWindow profile={infoProfile} />}
				</>
			)}
		</>
	);
};

export const IMBuddies: React.FC = () => (
	<ClassicyApp id={APP_ID} name={APP_NAME} icon={appIcon} defaultWindow="im_signon">
		<IMBuddiesProvider>
			<IMBuddiesContent />
		</IMBuddiesProvider>
	</ClassicyApp>
);
