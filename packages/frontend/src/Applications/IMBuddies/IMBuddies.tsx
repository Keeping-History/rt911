import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyMenuBarExtension,
	type ClassicyMenuItem,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManagerDispatch,
} from "classicy";
import type React from "react";
import { useCallback, useMemo } from "react";
import appIconPng from "./app.png";
import { BuddyListWindow } from "./BuddyListWindow";
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
 * People and Window menus, plus Quit. `ClassicyMenuBarExtension` is the first
 * use of this component in the repo: unlike the File/Edit-style `appMenu`
 * every other app passes to `ClassicyWindow` (rendered only while that
 * window is frontmost), it portal-renders a persistent button into the
 * desktop's menu-bar-extensions tray, visible for as long as this app is
 * open — not gated on which window (or even which app) currently has focus.
 * That is a real behavioral difference from the rest of this codebase's
 * menus, but its `title`/`children` + `menuItems` dropdown shape is what the
 * brief's People/Window menus need, so it's used as named here.
 *
 * Lives inside IMBuddiesProvider (unlike the ClassicyApp wrapper below it in
 * the tree) because it reads useIMBuddies() to build the Window list.
 */
const IMBuddiesMenus: React.FC = () => {
	const { connected, buddies, openChats, signOff } = useIMBuddies();
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

	// No separate "compose" picker exists in this app (building one is out of
	// scope for this task) -- New Message and Get Info both hand off to the
	// Buddy List, exactly where a student picks a buddy and uses its IM/Info
	// buttons to reach the same place these would otherwise open directly.
	const peopleItems = useMemo<ClassicyMenuItem[]>(
		() => [
			{
				id: "im_menu_new_message",
				title: "New Message",
				disabled: !connected,
				onClickFunc: () => focusWindow(BUDDY_LIST_WINDOW_ID),
			},
			{
				id: "im_menu_get_info",
				title: "Get Info",
				disabled: !connected,
				onClickFunc: () => focusWindow(BUDDY_LIST_WINDOW_ID),
			},
			{
				id: "im_menu_sign_off",
				title: "Sign Off",
				disabled: !connected,
				onClickFunc: signOff,
			},
			quitMenuItemHelper(APP_ID, APP_NAME, appIcon),
		],
		[connected, signOff, focusWindow],
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

	return (
		<>
			<IMBuddiesMenus />
			{!connected && <SignOnWindow />}
			{connected && <BuddyListWindow />}
			{openChats.map((profile) => (
				<ChatWindow key={profile} profile={profile} />
			))}
			{openInfo.map((profile) => (
				<InfoWindow key={profile} profile={profile} />
			))}
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
