import {
	ClassicyBalloonHelp,
	ClassicyBevelButton,
	ClassicyButtonToolbar,
	ClassicyButtonToolbarGroup,
	ClassicyMenu,
	type ClassicyMenuItem,
	ClassicyWindow,
} from "classicy";
import { useState } from "react";
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
	// Whether the Add Settings button's app dropdown is showing.
	const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);

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
		setSettingsMenuOpen(false);
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
					action.id === "settings" ? setSettingsMenuOpen((open) => !open) : run(action)
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
							// acting directly.
							return (
								<div key={action.id} className="playlistSettingsDropdown">
									{button(action)}
									{settingsMenuOpen && (
										<>
											{/* Invisible full-screen click-away; a button so it is
											    keyboard-dismissable, satisfying the a11y rules the
											    bare-div version tripped. The menu sits above it. */}
											<button
												type="button"
												aria-label="Close the Add Settings menu"
												className="playlistSettingsDropdownDismiss"
												onClick={() => setSettingsMenuOpen(false)}
											/>
											<div className="playlistSettingsDropdownMenu" role="presentation">
												<ClassicyMenu
													name="playlist_add_settings_dropdown"
													menuItems={settingsAppMenuItems(runSettings)}
													navClass="playlistSettingsDropdownNav"
												/>
											</div>
										</>
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
