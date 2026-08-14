import { type ClassicyMenuItem, ClassicyWindow } from "classicy";
import { EntryForm } from "./EntryForm";
import { SETTINGS_WINDOW_ID, usePlaylistEditor } from "./PlaylistEditorProvider";

/**
 * The Settings utility window: the single editing surface for whatever entry
 * is selected in the ACTIVE document — an app-settings entry's schema-driven
 * fields, a media/file entry's bounding date-times, a jump's times, an app
 * rule's target, a browser entry's URL and window. It replaced the EntryForm
 * pane that used to sit inside each document window, so the same editor now
 * serves every document instead of each carrying its own.
 *
 * Closable, unlike the Tools palette: Tools is the app's guaranteed menu
 * anchor; this window reopens from Window > Settings, an entry's Edit button,
 * or any Add action (all through the provider's `openSettingsWindow`).
 */
export function SettingsWindow({
	appId,
	icon,
	appMenu,
}: {
	appId: string;
	icon: string;
	appMenu: ClassicyMenuItem[];
}) {
	const { states, activeId, edit } = usePlaylistEditor();
	const state = activeId !== null ? states[activeId] : undefined;
	const selected = state?.entries.find((e) => e.uid === state.selectedUid) ?? null;

	return (
		<ClassicyWindow
			id={SETTINGS_WINDOW_ID}
			appId={appId}
			backgroundColor="var(--color-system-03)"
			title="Settings"
			icon={icon}
			windowType="utility"
			closable={true}
			resizable={true}
			zoomable={false}
			collapsable={true}
			scrollable={true}
			initialSize={[280, 240]}
			initialPosition={[440, 220]}
			appMenu={appMenu}
		>
			{selected && activeId !== null ? (
				<EntryForm
					// Remount per entry so per-entry draft state (JSON drafts)
					// never leaks between entries or documents.
					key={`${activeId}-${selected.uid}`}
					value={selected}
					onChange={(entry) =>
						edit(activeId, { type: "updateEntry", uid: selected.uid, entry })
					}
				/>
			) : (
				<p className="playlistSettingsEmpty">
					Select an entry in a playlist to edit its settings.
				</p>
			)}
		</ClassicyWindow>
	);
}
