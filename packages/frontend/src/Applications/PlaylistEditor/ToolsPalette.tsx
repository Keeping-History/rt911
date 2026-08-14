import {
	ClassicyBalloonHelp,
	ClassicyBevelButton,
	ClassicyButtonToolbar,
	ClassicyButtonToolbarGroup,
	ClassicyContextualMenu,
	type ClassicyMenuItem,
	ClassicyWindow,
} from "classicy";
import { useRef, useState } from "react";
import { ADD_ACTIONS, type AddAction, runAddAction, runAddSettings } from "./addActions";
import { usePlaylistEditor } from "./PlaylistEditorProvider";
import { settingsAppMenuItems } from "./playlistMenus";

/**
 * The palette's window id. Exported because `PlaylistEditor` dispatches at it
 * for `Window > Tools`: classicy's `ClassicyWindowOpen` reducer pushes a brand
 * new entry when it does not recognise the id and reads `position[0]` off the
 * action while doing it, so a drifted duplicate string would be a TypeError,
 * not a no-op.
 */
export const TOOLS_WINDOW_ID = "playlist_editor_tools";

/** Three groups; ClassicyButtonToolbar draws the engraved dividers between. */
const GROUPS: AddAction["id"][][] = [
	["media", "file"],
	["app", "settings"],
	["jump", "browser"],
];

/**
 * The floating tool palette. A utility-class window, so it gets the Platinum
 * crosshatch drag region rather than a document title bar.
 *
 * It is `closable={false}` because it is the app's guaranteed menu anchor: with
 * every other window closable and quitting reachable only from File > Quit,
 * closing everything would otherwise leave the menu bar showing a dead
 * window's menus. Collapsing it covers the "get it out of my way" need.
 *
 * `appMenu` is passed unconditionally. The design originally supplied it only
 * while no document window was open, so that clicking the palette left the
 * frontmost document's menus alone — but withholding the prop cannot achieve
 * that: classicy's focus reducer falls back to the window's *stored* `menuBar`,
 * and the `ClassicyWindowSetMenuBar` effect early-returns when no menu is
 * supplied, so the palette would keep serving whatever menu it stored earlier.
 * That made the swap happen anyway, with a stale menu. See decision 9 in
 * plans/2026-08-13-playlist-editor-multiwindow-design.md.
 */
export function ToolsPalette({
	appId,
	icon,
	appMenu,
}: {
	appId: string;
	icon: string;
	appMenu: ClassicyMenuItem[];
}) {
	const { activeId, edit, setDialogMode, openSettingsWindow } = usePlaylistEditor();
	// Where the Add Settings app menu is showing (fixed viewport coords under
	// the button), or null while it is not. A ClassicyContextualMenu rather
	// than anything anchored inside this window: the palette window is
	// scrollable={false} (overflow: hidden), so an absolutely-positioned
	// dropdown under the toolbar is clipped into invisibility — the menu must
	// be position:fixed to escape, which the contextual menu already is.
	const [settingsMenuPos, setSettingsMenuPos] = useState<[number, number] | null>(null);
	const settingsAnchorRef = useRef<HTMLDivElement>(null);
	// The contextual menu closes itself on any outside MOUSEDOWN — including
	// the one that starts a second click on the Settings button. Without this
	// stamp, that click's own CLICK phase would see "closed" and immediately
	// reopen, making the button impossible to toggle shut.
	const suppressReopenUntil = useRef(0);

	const toggleSettingsMenu = () => {
		if (settingsMenuPos !== null) {
			setSettingsMenuPos(null);
			return;
		}
		if (Date.now() < suppressReopenUntil.current) return;
		const rect = settingsAnchorRef.current?.getBoundingClientRect();
		setSettingsMenuPos(rect ? [rect.left, rect.bottom + 2] : [440, 160]);
	};

	const closeSettingsMenu = () => {
		suppressReopenUntil.current = Date.now() + 300;
		setSettingsMenuPos(null);
	};

	const handlers = (playlistId: string) => ({
		playlistId,
		edit,
		setDialogMode,
		openSettings: openSettingsWindow,
	});

	const run = (action: AddAction) => {
		if (activeId === null) return;
		runAddAction(action, handlers(activeId));
	};

	const runSettings = (settingsAppId: string) => {
		setSettingsMenuPos(null);
		if (activeId === null) return;
		runAddSettings(settingsAppId, handlers(activeId));
	};

	const button = (action: AddAction) => (
		<ClassicyBalloonHelp key={action.id} title={action.label} content={action.balloon}>
			<ClassicyBevelButton
				icon={action.icon}
				iconAlt={action.label}
				aria-label={action.label}
				disabled={activeId === null}
				onClickFunc={() =>
					action.id === "settings" ? toggleSettingsMenu() : run(action)
				}
			/>
		</ClassicyBalloonHelp>
	);

	return (
		<ClassicyWindow
			id={TOOLS_WINDOW_ID}
			appId={appId}
			backgroundColor="var(--color-system-03)"
			title="Tools"
			icon={icon}
			windowType="utility"
			closable={false}
			resizable={false}
			zoomable={false}
			collapsable={true}
			scrollable={false}
			initialSize={[0, 0]}
			initialPosition={[440, 120]}
			appMenu={appMenu}
		>
			<ClassicyButtonToolbar className="playlistToolsPalette">
				{GROUPS.map((group) => (
					<ClassicyButtonToolbarGroup key={group.join("-")}>
						{group.map((id) => {
							const action = ADD_ACTIONS.find((a) => a.id === id);
							if (!action) return null;
							if (action.id !== "settings") return button(action);
							// Add Settings drops down a menu of registered apps
							// (same items as Edit > Add… > Settings) instead of
							// acting directly. The div is only the position anchor.
							return (
								<div
									key={action.id}
									ref={settingsAnchorRef}
									className="playlistSettingsDropdown"
								>
									{button(action)}
									{settingsMenuPos && (
										<ClassicyContextualMenu
											name="playlist_add_settings_dropdown"
											position={settingsMenuPos}
											menuItems={settingsAppMenuItems(runSettings)}
											onClose={closeSettingsMenu}
										/>
									)}
								</div>
							);
						})}
					</ClassicyButtonToolbarGroup>
				))}
			</ClassicyButtonToolbar>
		</ClassicyWindow>
	);
}
