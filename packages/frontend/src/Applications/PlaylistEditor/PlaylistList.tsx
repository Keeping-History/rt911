import {
	ClassicyButton,
	ClassicyControlLabel,
	ClassicyTable,
	type ClassicyTableColumn,
} from "classicy";
import { useCallback, useEffect, useState } from "react";
import {
	createPlaylist,
	deletePlaylist,
	duplicatePlaylist,
	getPlaylist,
	listMine,
	type PlaylistRecord,
	type PlaylistSummary,
} from "../../Providers/Auth/playlistApi";
import { AuthRequiredError } from "../../Providers/Auth/authApi";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { usePlaylistEditor } from "./PlaylistEditorProvider";

const EMPTY_DEFINITION = { version: 1 as const, mode: "annotate" as const, entries: [] };

/** Directus stores the workflow state lowercase ("draft"); show it as a word. */
function formatStatus(status: string): string {
	return status ? status[0].toUpperCase() + status.slice(1) : "";
}

/**
 * When the playlist was last saved, in the reader's own timezone.
 *
 * Deliberately NOT routed through the virtual clock: every other date in this
 * product is a September 2001 instant, but this one is real wall-clock time —
 * when the teacher last edited the document — so it is formatted like any
 * ordinary file's modification date. An em dash marks a playlist Directus has
 * never stamped.
 */
function formatModified(iso: string | null): string {
	if (!iso) return "—";
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "—";
	return at.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

const COLUMNS: ClassicyTableColumn<PlaylistSummary>[] = [
	{ id: "title", title: "Name", accessor: (r) => r.title, width: 190 },
	{
		id: "status",
		title: "Status",
		accessor: (r) => r.status,
		render: (r) => formatStatus(r.status),
		width: 90,
	},
	{
		id: "date_updated",
		title: "Date Modified",
		// Sort on the raw ISO, not the rendered text: lexicographic order over
		// ISO instants is chronological, "Jul 16, 2026" is not.
		accessor: (r) => r.date_updated ?? "",
		render: (r) => formatModified(r.date_updated),
		width: 150,
	},
];

export function PlaylistList({
	meId,
	onOpen,
	refreshToken = 0,
}: {
	meId: string;
	onOpen: (record: PlaylistRecord) => void;
	/**
	 * Refetch whenever this changes. This window never unmounts now, so a save,
	 * rename, duplicate, create or delete performed anywhere else in the app
	 * would otherwise never reach it — leaving stale titles and rows whose Open
	 * button 404s.
	 */
	refreshToken?: number;
}) {
	const [rowsState, setRows] = useState<PlaylistSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { refresh: refreshAuth } = useAuth();
	const { openIds, closePlaylistWindow } = usePlaylistEditor();

	const refresh = useCallback(async () => {
		try {
			setRows(await listMine(meId));
		} catch (e) {
			if (e instanceof AuthRequiredError) {
				void refreshAuth();
				return;
			}
			setError(e instanceof Error ? e.message : "Couldn't load playlists.");
		}
	}, [meId, refreshAuth]);

	useEffect(() => {
		void refresh();
	}, [refresh, refreshToken]);

	const selected = rowsState.find((r) => r.id === selectedId) ?? null;

	const run = (job: () => Promise<void>) => () => {
		setError(null);
		void job().catch((e) => {
			if (e instanceof AuthRequiredError) {
				void refreshAuth();
				return;
			}
			setError(e instanceof Error ? e.message : "Something went wrong.");
		});
	};

	// One code path for every "open this playlist" gesture — the Open button,
	// a double-click, and Enter on the selected row — so they cannot drift.
	const openById = (id: string) =>
		run(async () => {
			onOpen(await getPlaylist(id));
		})();

	return (
		<div className="playlistList">
			<ClassicyControlLabel label="My Playlists" />
			{error && <p className="playlistListError">{error}</p>}
			<div className="playlistListTable">
				<ClassicyTable
					columns={COLUMNS}
					rows={rowsState}
					getRowId={(r) => r.id}
					selectionMode="single"
					selected={selectedId ? [selectedId] : []}
					onSelectionChange={(ids) => {
						setSelectedId(ids[0] ?? null);
						setConfirmingDelete(false);
					}}
					onActivateRow={openById}
					defaultSort={{ columnId: "date_updated", desc: true }}
				/>
				{/* The table keeps its header so an empty account still shows the
				    window's shape rather than a blank box. */}
				{rowsState.length === 0 && (
					<ClassicyControlLabel label="No playlists yet." />
				)}
			</div>
			{confirmingDelete && selected && (
				<div className="playlistDeleteConfirm">
					<span>{`Delete "${selected.title}"? This cannot be undone.`}</span>
					<ClassicyButton
						onClickFunc={run(async () => {
							const deletedId = selected.id;
							await deletePlaylist(deletedId);
							// A document window open on the deleted playlist would
							// otherwise stay fully mounted on an id that no longer
							// exists, with its File/Edit/Control menus still acting on
							// it (Save PATCHes a 404, Lock Clock sends a doomed room
							// command). Close it exactly the way File > Delete… closes
							// its own window. Guarded, because closing a window classicy
							// has never heard of would still make its reducer refocus
							// this app's topmost window — stealing focus from the list
							// when the deleted playlist was not open at all.
							if (openIds.includes(deletedId)) closePlaylistWindow(deletedId);
							setConfirmingDelete(false);
							setSelectedId(null);
							await refresh();
						})}
					>
						{`Delete "${selected.title}"`}
					</ClassicyButton>
					<ClassicyButton onClickFunc={() => setConfirmingDelete(false)}>
						Cancel
					</ClassicyButton>
				</div>
			)}
			<div className="playlistListActions">
				<ClassicyButton
					onClickFunc={run(async () => {
						const record = await createPlaylist("Untitled Playlist", EMPTY_DEFINITION);
						onOpen(record);
						await refresh();
					})}
				>
					New
				</ClassicyButton>
				<ClassicyButton
					disabled={!selected}
					onClickFunc={() => {
						if (selected) openById(selected.id);
					}}
				>
					Open
				</ClassicyButton>
				<ClassicyButton
					disabled={!selected}
					onClickFunc={run(async () => {
						if (selected) {
							await duplicatePlaylist(selected.id);
							await refresh();
						}
					})}
				>
					Duplicate
				</ClassicyButton>
				<ClassicyButton disabled={!selected} onClickFunc={() => setConfirmingDelete(true)}>
					Delete
				</ClassicyButton>
				{selected?.status === "published" && (
					<ClassicyButton
						onClickFunc={() =>
							void navigator.clipboard.writeText(
								`${location.origin}/?playlist=${selected.id}`,
							)
						}
					>
						Copy Link
					</ClassicyButton>
				)}
			</div>
		</div>
	);
}
