import {
	ClassicyBalloonHelp,
	ClassicyBevelButton,
	ClassicyButtonToolbar,
	ClassicyButtonToolbarGroup,
	type ClassicyMenuItem,
	ClassicyWindow,
} from "classicy";
import { ADD_ACTIONS, type AddAction, runAddAction } from "./addActions";
import { usePlaylistEditor } from "./PlaylistEditorProvider";

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
 * `appMenu` is passed ONLY when no document window is open. While a document
 * exists this palette stays menu-less, so clicking it leaves the frontmost
 * document's menus on screen instead of swapping the menu bar out mid-click —
 * classicy's focus reducer assigns Desktop.appMenu only when the newly focused
 * window supplies one.
 */
export function ToolsPalette({
	appId,
	icon,
	appMenu,
}: {
	appId: string;
	icon: string;
	appMenu?: ClassicyMenuItem[];
}) {
	const { activeId, edit, setDialogMode } = usePlaylistEditor();

	const run = (action: AddAction) => {
		if (activeId === null) return;
		runAddAction(action, { playlistId: activeId, edit, setDialogMode });
	};

	return (
		<ClassicyWindow
			id="playlist_editor_tools"
			appId={appId}
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
							return (
								<ClassicyBalloonHelp
									key={action.id}
									title={action.label}
									content={action.balloon}
								>
									<ClassicyBevelButton
										icon={action.icon}
										iconAlt={action.label}
										aria-label={action.label}
										disabled={activeId === null}
										onClickFunc={() => run(action)}
									/>
								</ClassicyBalloonHelp>
							);
						})}
					</ClassicyButtonToolbarGroup>
				))}
			</ClassicyButtonToolbar>
		</ClassicyWindow>
	);
}
