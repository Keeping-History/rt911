import { ClassicyButton } from "classicy";
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

const EMPTY_DEFINITION = { version: 1 as const, mode: "annotate" as const, entries: [] };

export function PlaylistList({
	meId,
	onOpen,
}: {
	meId: string;
	onOpen: (record: PlaylistRecord) => void;
}) {
	const [rowsState, setRows] = useState<PlaylistSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setRows(await listMine(meId));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't load playlists.");
		}
	}, [meId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selected = rowsState.find((r) => r.id === selectedId) ?? null;

	const run = (job: () => Promise<void>) => () => {
		setError(null);
		void job().catch((e) =>
			setError(e instanceof Error ? e.message : "Something went wrong."),
		);
	};

	return (
		<div className="playlistList">
			<h1>My Playlists</h1>
			{error && <p className="playlistListError">{error}</p>}
			<ul className="playlistListRows">
				{rowsState.map((r) => (
					<li key={r.id}>
						<button
							type="button"
							className={r.id === selectedId ? "playlistRowSelected" : undefined}
							onClick={() => {
								setSelectedId(r.id);
								setConfirmingDelete(false);
							}}
						>
							{r.title}
							<span className="playlistRowStatus">{r.status}</span>
							<span className="playlistRowDate">{r.date_updated ?? ""}</span>
						</button>
					</li>
				))}
			</ul>
			{confirmingDelete && selected && (
				<div className="playlistDeleteConfirm">
					<span>{`Delete "${selected.title}"? This cannot be undone.`}</span>
					<ClassicyButton
						onClickFunc={run(async () => {
							await deletePlaylist(selected.id);
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
					})}
				>
					New
				</ClassicyButton>
				<ClassicyButton
					disabled={!selected}
					onClickFunc={run(async () => {
						if (selected) onOpen(await getPlaylist(selected.id));
					})}
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
