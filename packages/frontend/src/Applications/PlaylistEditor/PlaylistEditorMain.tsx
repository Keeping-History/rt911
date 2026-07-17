import {
	ClassicyButton,
	ClassicyFileOpenDialog,
	type ClassicyFileOpenSelection,
	ClassicyTree,
	type ClassicyTreeNode,
	desktopVolume,
	fileSystemVolume,
	useClassicyFileSystem,
} from "classicy";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import type { PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import { useMediaStream } from "../../Providers/MediaStream/useMediaStream";
import { createDirectusVolume, MEDIA_FILE_TYPES } from "./directusVolume";
import {
	editorReducer,
	type EditorEntry,
	initialEditorState,
	selectionsToEntries,
	utcIsoToDisplayWallClock,
} from "./editorState";
import { EntryForm } from "./EntryForm";
import { PlaylistTimeline } from "./PlaylistTimeline";
import { SaveBar } from "./SaveBar";

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

export function PlaylistEditorMain({
	record,
	onBack,
	onDirtyChange = () => {},
	closeRequested = false,
	onCancelClose = () => {},
	onQuit = () => {},
}: {
	record: PlaylistRecord;
	onBack: () => void;
	/** Fired on mount and whenever dirtiness changes, so the owning window
	 * (PlaylistEditor) can gate its close confirmation without holding its own
	 * copy of the editor state. */
	onDirtyChange?: (dirty: boolean) => void;
	/** True while the owning window wants to close but the editor is dirty:
	 * swaps the whole editor body for a three-button save/discard/cancel strip. */
	closeRequested?: boolean;
	onCancelClose?: () => void;
	onQuit?: () => void;
}) {
	const [state, dispatch] = useReducer(editorReducer, record, initialEditorState);
	const [dialogMode, setDialogMode] = useState<"media" | "file" | null>(null);

	useEffect(() => {
		onDirtyChange(state.dirty);
	}, [state.dirty, onDirtyChange]);
	const fs = useClassicyFileSystem();
	const { sources } = useMediaStream();
	// sources object identity changes on WS updates; the volume's closures read
	// this ref (not the render's `sources`) so they always see the live lists,
	// even though the volume itself is created only once (below).
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;

	const localVolumes = useMemo(
		() => [desktopVolume(fs), fileSystemVolume(fs, "Macintosh HD")],
		[fs],
	);
	const archiveVolume = useMemo(
		() =>
			createDirectusVolume({
				tvSlugs: () => sourcesRef.current.video,
				radioSlugs: () => sourcesRef.current.audio,
			}),
		// volume identity must stay stable for the dialog's per-folder cache
		[],
	);

	const selected = state.entries.find((e) => e.uid === state.selectedUid) ?? null;

	const nodes: ClassicyTreeNode[] = KIND_BRANCHES.map(([kind, label]) => ({
		id: `branch-${kind}`,
		label,
		defaultOpen: true,
		children: state.entries
			.filter((e) => e.entry.kind === kind)
			.map((e) => ({
				id: e.uid,
				label: entrySummary(e),
				buttons: [
					{ label: "Edit", onClickFunc: () => dispatch({ type: "select", uid: e.uid }) },
					{ label: "Remove", onClickFunc: () => dispatch({ type: "removeEntry", uid: e.uid }) },
				],
			})),
	})).filter((b) => (b.children?.length ?? 0) > 0);

	const handleDialogOpen = (selections: ClassicyFileOpenSelection[]) => {
		dispatch({ type: "addEntries", entries: selectionsToEntries(selections) });
		setDialogMode(null);
	};

	// The owning window asked to close while the editor is dirty: replace the
	// whole editor body with a save/discard/cancel strip instead of layering a
	// modal over it. Reuses SaveBar so the strip's Save button gets the same
	// invalid/warnings gate as the always-on Save above, rather than a second
	// copy of that logic.
	if (closeRequested) {
		return (
			<div className="playlistEditorMain">
				<div className="playlistEditorCloseConfirm">
					<p>{`Save changes to "${state.title}" before closing?`}</p>
					<SaveBar state={state} onSaved={onQuit} warningCancelLabel="Keep Editing" />
					<ClassicyButton onClickFunc={onQuit}>Don't Save</ClassicyButton>
					<ClassicyButton onClickFunc={onCancelClose}>Cancel</ClassicyButton>
				</div>
			</div>
		);
	}

	return (
		<div className="playlistEditorMain">
			<div className="playlistEditorHeader">
				<ClassicyButton onClickFunc={onBack}>‹ My Playlists</ClassicyButton>
				<label>
					Title
					<input
						aria-label="Title"
						type="text"
						value={state.title}
						onChange={(e) => dispatch({ type: "setTitle", title: e.target.value })}
					/>
				</label>
				<label>
					<input type="radio" name="mode" checked={state.mode === "restrict"}
						onChange={() => dispatch({ type: "setMode", mode: "restrict" })} />
					Restrict
				</label>
				<label>
					<input type="radio" name="mode" checked={state.mode === "annotate"}
						onChange={() => dispatch({ type: "setMode", mode: "annotate" })} />
					Annotate
				</label>
				<select aria-label="Status" value={state.status}
					onChange={(e) => dispatch({ type: "setStatus", status: e.target.value as "draft" | "published" })}>
					<option value="draft">Draft</option>
					<option value="published">Published</option>
				</select>
				<SaveBar state={state} onSaved={() => dispatch({ type: "markSaved" })} />
			</div>

			<div className="playlistEditorAddBar">
				<ClassicyButton onClickFunc={() => setDialogMode("media")}>Add Media…</ClassicyButton>
				<ClassicyButton onClickFunc={() => setDialogMode("file")}>Add File…</ClassicyButton>
				<ClassicyButton onClickFunc={() => dispatch({ type: "addEntries", entries: [{ entry: { kind: "app", appId: "TimeMachine.app", disabled: true } }] })}>Add App Rule</ClassicyButton>
				<ClassicyButton onClickFunc={() => dispatch({ type: "addEntries", entries: [{ entry: { kind: "settings", appId: "TV.app", values: {} } }] })}>Add Settings</ClassicyButton>
				<ClassicyButton onClickFunc={() => dispatch({ type: "addEntries", entries: [{ entry: { kind: "jump", at: "", to: "" } }] })}>Add Jump</ClassicyButton>
				<ClassicyButton onClickFunc={() => dispatch({ type: "addEntries", entries: [{ entry: { kind: "browser", url: "http://", at: "" } }] })}>Add Browser</ClassicyButton>
			</div>

			<div className="playlistEditorBody">
				<div className="playlistEditorEntries">
					<ClassicyTree nodes={nodes} />
				</div>
				{selected && (
					<EntryForm
						key={selected.uid}
						value={selected}
						onChange={(entry) => dispatch({ type: "updateEntry", uid: selected.uid, entry })}
					/>
				)}
			</div>

			<PlaylistTimeline
				entries={state.entries}
				selectedUid={state.selectedUid}
				onSelect={(uid) => dispatch({ type: "select", uid })}
			/>

			<ClassicyFileOpenDialog
				id="playlist_editor_open"
				appId="PlaylistEditor.app"
				open={dialogMode !== null}
				title={dialogMode === "media" ? "Add Media" : "Add File"}
				volumes={dialogMode === "media" ? [...localVolumes, archiveVolume] : localVolumes}
				selectionMode={dialogMode === "media" ? "multi" : "single"}
				fileTypeFilters={
					dialogMode === "media"
						? [
								{ label: "All Media", types: Object.values(MEDIA_FILE_TYPES) },
								{ label: "TV Channels", types: [MEDIA_FILE_TYPES.tv] },
								{ label: "Radio Stations", types: [MEDIA_FILE_TYPES.radio] },
								{ label: "News", types: [MEDIA_FILE_TYPES.news] },
								{ label: "Flights", types: [MEDIA_FILE_TYPES.flight] },
							]
						: undefined
				}
				onOpenFunc={handleDialogOpen}
				onCancelFunc={() => setDialogMode(null)}
			/>
		</div>
	);
}
