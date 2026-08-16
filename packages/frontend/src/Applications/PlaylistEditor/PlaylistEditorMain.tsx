import { ClassicyControlLabel, ClassicySplitView, ClassicyTabs, ClassicyTree, type ClassicyTreeNode } from "classicy";
import type { ReactNode } from "react";
import { Disclosure } from "../../Components/Disclosure/Disclosure";
import type { MediaEntry, PlaylistApp, PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import { type EditorAction, type EditorEntry, type EditorState, utcIsoToDisplayWallClock } from "./editorState";
import { MediaTvRow, type TvEditorEntry } from "./MediaTvRow";
import { PlaylistTimeline } from "./PlaylistTimeline";

const KIND_BRANCHES: [PlaylistEntry["kind"], string][] = [
	["media", "Media"], ["app", "Apps"], ["settings", "Settings"],
	["file", "Files"], ["jump", "Jumps"], ["browser", "Browser"],
];

// The Media tab's per-app disclosure sections, in broadcast-dial order.
const MEDIA_SECTIONS: [PlaylistApp, string, string][] = [
	["tv", "TV Channels", "No TV channels yet."],
	["radio", "Radio Stations", "No radio stations yet."],
	["news", "News", "No news stories yet."],
	["flights", "Flights", "No flights yet."],
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
 * the File/Edit menus and the Tools palette now, so a resizable vertical
 * split view fills the window: the timeline on top, the entries grouped by
 * kind in a tab group below. Entry EDITING is gone too — an entry's Edit button
 * selects it and reveals the shared Settings utility window (SettingsWindow),
 * which renders the form for the active document's selection. This component
 * holds no state — its owning document window passes the playlist's slice of
 * the keyed store, a dispatcher, and the Settings-window opener.
 */
export function PlaylistEditorMain({
	state,
	edit,
	openSettings = () => {},
	zoom,
	onZoomChange,
}: {
	state: EditorState;
	edit: (playlistId: string, action: EditorAction) => void;
	/** Reveal the Settings utility window; wired to the provider's
	 * openSettingsWindow by PlaylistDocumentWindow. */
	openSettings?: () => void;
	/** Timeline zoom, owned by the document window so the View menu and the
	 * timeline's own buttons drive one value. Passed straight through — this
	 * component still holds no state of its own. */
	zoom: number;
	onZoomChange: (zoom: number) => void;
}) {
	const dispatch = (action: EditorAction) => edit(state.playlistId, action);

	const editEntry = (uid: string) => {
		dispatch({ type: "select", uid });
		openSettings();
	};

	// Tree rows keep the ClassicyTree chrome (flat, branchless nodes) so
	// Edit/Remove render the same everywhere they still appear.
	const treeNodes = (entries: EditorEntry[]): ClassicyTreeNode[] =>
		entries.map((e) => ({
			id: e.uid,
			label: entrySummary(e),
			buttons: [
				{ label: "Edit", onClickFunc: () => editEntry(e.uid) },
				{ label: "Remove", onClickFunc: () => dispatch({ type: "removeEntry", uid: e.uid }) },
			],
		}));

	// The Media tab splits into one disclosure per media app. TV renders as a
	// side-scrolling logo-card row (MediaTvRow); the other three keep tree rows
	// for now. Sections always boot open: entries load from Directus after
	// first render, and a closed-at-mount section would hide them on arrival.
	const mediaEntries = state.entries.filter(
		(e): e is EditorEntry & { entry: MediaEntry } => e.entry.kind === "media",
	);
	const mediaTab = (
		<div className="playlistMediaSections">
			{MEDIA_SECTIONS.map(([app, label, emptyHint]) => {
				const entries = mediaEntries.filter((e) => e.entry.app === app);
				let body: ReactNode;
				if (entries.length === 0) {
					body = <ClassicyControlLabel label={emptyHint} />;
				} else if (app === "tv") {
					body = (
						<MediaTvRow
							entries={entries as TvEditorEntry[]}
							selectedUid={state.selectedUid}
							onEdit={editEntry}
							onRemove={(uid) => dispatch({ type: "removeEntry", uid })}
						/>
					);
				} else {
					body = <ClassicyTree nodes={treeNodes(entries)} />;
				}
				return (
					<Disclosure key={app} label={label} defaultOpen>
						{body}
					</Disclosure>
				);
			})}
		</div>
	);

	// One tab per entry kind, always all six: stable tab positions beat the old
	// tree's hide-empty-branches behavior.
	const tabs = KIND_BRANCHES.map(([kind, label]) => {
		if (kind === "media") return { title: label, children: mediaTab };
		const nodes = treeNodes(state.entries.filter((e) => e.entry.kind === kind));
		return {
			title: label,
			children:
				nodes.length > 0 ? (
					<ClassicyTree nodes={nodes} />
				) : (
					<ClassicyControlLabel label={`No ${label.toLowerCase()} entries yet.`} />
				),
		};
	});

	return (
		<div className="playlistEditorMain">
			<ClassicySplitView direction="vertical" defaultSizes={[30, 70]}>
				<PlaylistTimeline
					entries={state.entries}
					selectedUid={state.selectedUid}
					onSelect={(uid) => dispatch({ type: "select", uid })}
					onSetEntryBound={(uid, edge, iso) => {
						const e = state.entries.find((x) => x.uid === uid);
						if (!e || e.entry.kind !== "media") return;
						dispatch({ type: "updateEntry", uid, entry: { ...e.entry, [edge]: iso } });
					}}
					zoom={zoom}
					onZoomChange={onZoomChange}
					start={state.start}
					end={state.end}
				/>
				<div className="playlistEditorEntries">
					<ClassicyTabs tabs={tabs} />
				</div>
			</ClassicySplitView>
		</div>
	);
}
