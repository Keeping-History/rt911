import {
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
import { useCallback, useMemo } from "react";
import appIconPng from "./app.png";
import { BuddyListWindow, isMessageable } from "./BuddyListWindow";
import { ChatWindow } from "./ChatWindow";
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

	const peopleItems = useMemo<ClassicyMenuItem[]>(
		() => [
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
		],
		[connected, selectedBuddyObj, openChat, openInfoFor, signOff],
	);

	// Rebuilt fresh every render from openChats/buddies -- never snapshotted --
	// so a chat window opening or closing is reflected in the very same render
	// that adds/removes its <ChatWindow> below, not a stale copy from whenever
	// this menu last happened to re-run.
	const windowItems = useMemo<ClassicyMenuItem[]>(() => {
		const items: ClassicyMenuItem[] = [
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
	}, [connected, openChats, buddies, focusWindow]);

	return (
		<>
			<ClassicyMenuBarExtension id="im_menu_people" order={1} title="People" menuItems={peopleItems}>
				People
			</ClassicyMenuBarExtension>
			<ClassicyMenuBarExtension id="im_menu_window" order={2} title="Window" menuItems={windowItems}>
				Window
			</ClassicyMenuBarExtension>
		</>
	);
};

/**
 * Sign On while disconnected, Buddy List once connected, plus one Chat/Info
 * window per entry in openChats/openInfo -- mapped live off provider state,
 * never a fixed "all buddies" list, so a closed conversation's window
 * actually disappears instead of just losing focus.
 */
const IMBuddiesContent: React.FC = () => {
	const { connected, openChats, openInfo } = useIMBuddies();
	// Same selector idiom as PlaylistProvider.tsx: read app-manager state
	// directly rather than plumbing a prop. IMBuddiesMenus is only ever
	// mounted while this app is the frontmost one -- see the comment on that
	// component for why that matters.
	const isFrontmost = useAppManager(
		(s) => s.System.Manager.Applications.focusedAppId === APP_ID,
	);

	return (
		<>
			{isFrontmost && <IMBuddiesMenus />}
			{!connected && <SignOnWindow />}
			{/*
			  Every window below the Sign On window is gated on `connected` too,
			  not just the Buddy List. A dropped socket flips `connected` false
			  (that is what CRITICAL 1's derivation bought) while openChats /
			  openInfo are cleared only by signOff — so without this gate a
			  student would be left looking at chat windows sitting beside the
			  Sign On window, on top of a conversation they can no longer
			  continue. The lists themselves are kept, so a recovered socket
			  restores the same windows rather than dumping the session.
			*/}
			{connected && (
				<>
					<BuddyListWindow />
					{openChats.map((profile) => (
						<ChatWindow key={profile} profile={profile} />
					))}
					{openInfo.map((profile) => (
						<InfoWindow key={profile} profile={profile} />
					))}
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
