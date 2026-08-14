import { ClassicyTabs, ClassicyTree, type ClassicyTreeNode } from "classicy";
import type { PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import { type EditorAction, type EditorEntry, type EditorState, utcIsoToDisplayWallClock } from "./editorState";
import { PlaylistTimeline } from "./PlaylistTimeline";

const KIND_BRANCHES: [PlaylistEntry["kind"], string][] = [
	["media", "Media"], ["app", "Apps"], ["settings", "Settings"],
	["file", "Files"], ["jump", "Jumps"], ["browser", "Browser"],
];

function entrySummary(e: EditorEntry): string {
	const t = (iso: string) => {
		const w = utcIsoToDisplayWallClock(iso);
		return `${String(w.getHours()).padStart(2, "0")}:${String(w.getMinutes()).padStart(2, "0")}`;
	};
	switch (e.entry.kind) {
		case "media": return `${e.entry.app.toUpperCase()} · ${e.entry.itemId}`;
		case "app": return `Disable ${e.entry.appId}`;
		case "settings": return `Settings ${e.entry.appId}`;
		case "file": return `${e.entry.path.split(":").pop()}${e.entry.at ? ` @ ${t(e.entry.at)}` : ""}`;
		case "jump": return `Jump ${e.entry.at ? t(e.entry.at) : "?"} → ${e.entry.to ? t(e.entry.to) : "?"}`;
		case "browser": return `${e.entry.url}${e.entry.at ? ` @ ${t(e.entry.at)}` : ""}`;
	}
}

/**
 * The editing surface, and nothing else.
 *
 * The header (title, mode, status, Save) and the Add bar are gone: they live in
 * the File/Edit menus and the Tools palette now, so the timeline is the
 * window's first child, with the entries grouped by kind in a tab group below
 * it. Entry EDITING is gone too — an entry's Edit button
 * selects it and reveals the shared Settings utility window (SettingsWindow),
 * which renders the form for the active document's selection. This component
 * holds no state — its owning document window passes the playlist's slice of
 * the keyed store, a dispatcher, and the Settings-window opener.
 */
export function PlaylistEditorMain({
	state,
	edit,
	openSettings = () => {},
}: {
	state: EditorState;
	edit: (playlistId: string, action: EditorAction) => void;
	/** Reveal the Settings utility window; wired to the provider's
	 * openSettingsWindow by PlaylistDocumentWindow. */
	openSettings?: () => void;
}) {
	const dispatch = (action: EditorAction) => edit(state.playlistId, action);

	// One tab per entry kind, always all six: stable tab positions beat the old
	// tree's hide-empty-branches behavior. Rows keep the ClassicyTree chrome
	// (flat, branchless nodes) so Edit/Remove render the same as before.
	const tabs = KIND_BRANCHES.map(([kind, label]) => {
		const nodes: ClassicyTreeNode[] = state.entries
			.filter((e) => e.entry.kind === kind)
			.map((e) => ({
				id: e.uid,
				label: entrySummary(e),
				buttons: [
					{
						label: "Edit",
						onClickFunc: () => {
							dispatch({ type: "select", uid: e.uid });
							openSettings();
						},
					},
					{ label: "Remove", onClickFunc: () => dispatch({ type: "removeEntry", uid: e.uid }) },
				],
			}));
		return {
			title: label,
			children:
				nodes.length > 0 ? (
					<ClassicyTree nodes={nodes} />
				) : (
					<p className="playlistEditorTabEmpty">No {label.toLowerCase()} entries yet.</p>
				),
		};
	});

	return (
		<div className="playlistEditorMain">
			<PlaylistTimeline
				entries={state.entries}
				selectedUid={state.selectedUid}
				onSelect={(uid) => dispatch({ type: "select", uid })}
			/>

			<div className="playlistEditorEntries">
				<ClassicyTabs tabs={tabs} />
			</div>
		</div>
	);
}
