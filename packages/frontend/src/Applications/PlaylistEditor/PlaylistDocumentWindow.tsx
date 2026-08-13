import { ClassicyAlert, type ClassicyMenuItem, ClassicyWindow, useAppManager } from "classicy";
import { useEffect, useMemo, useState } from "react";
import { deletePlaylist, duplicatePlaylist, getPlaylist, updatePlaylist } from "../../Providers/Auth/playlistApi";
import { ADD_ACTIONS, type AddAction, runAddAction } from "./addActions";
import {
	addMenuItems, documentControlMenu, documentEditMenu, documentFileMenu, windowMenu,
} from "./playlistMenus";
import { PlaylistEditorMain } from "./PlaylistEditorMain";
import { usePlaylistEditor } from "./PlaylistEditorProvider";
import { RenameDialog } from "./RenameDialog";
import { useSavePlaylist } from "./useSavePlaylist";

/** Cascade so a second window does not land exactly on the first. */
const CASCADE = 24;

type Pending = null | { kind: "close" } | { kind: "delete" };

export function PlaylistDocumentWindow({
	playlistId, index, appId, appIcon, quitItem,
	onFocusTools, onFocusList, onFocusDocument, onOpenList,
}: {
	playlistId: string;
	index: number;
	appId: string;
	appIcon: string;
	quitItem: ClassicyMenuItem;
	onFocusTools: () => void;
	onFocusList: () => void;
	onFocusDocument: (playlistId: string) => void;
	onOpenList: () => void;
}) {
	const {
		states, openIds, locks, lockError, edit, setActive, closePlaylist,
		openPlaylist, toggleClockLock, dismissLockError, setDialogMode,
	} = usePlaylistEditor();
	const state = states[playlistId];
	const windowId = `playlist_doc_${playlistId}`;

	const [pending, setPending] = useState<Pending>(null);
	const [renaming, setRenaming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { prompt, save, confirmSave, dismiss } = useSavePlaylist(
		state,
		() => edit(playlistId, { type: "markSaved" }),
	);

	// Claim the palette's target whenever this window is the focused one.
	// Focusing the PALETTE does not run this, which is exactly right: a
	// palette click must keep acting on the document the user was last in.
	const focused = useAppManager(
		(s) =>
			s.System.Manager.Applications.apps[appId]?.windows.find((w) => w.id === windowId)
				?.focused ?? false,
	);
	useEffect(() => {
		if (focused) setActive(playlistId);
	}, [focused, playlistId, setActive]);

	const runAdd = (action: AddAction) =>
		runAddAction(action, { playlistId, edit, setDialogMode });

	const appMenu = useMemo<ClassicyMenuItem[]>(
		() => [
			documentFileMenu({
				dirty: state.dirty,
				status: state.status,
				onOpenList,
				onSave: save,
				onRename: () => setRenaming(true),
				// Rename writes the title ALONE. updatePlaylist takes a partial
				// patch, so omitting `definition` means renaming cannot smuggle
				// the document's unsaved entry edits into a save the user did
				// not ask for.
				onDuplicate: () => {
					void duplicatePlaylist(playlistId)
						.then((copy) => getPlaylist(copy.id))
						.then(openPlaylist)
						.catch((e) => setError(e instanceof Error ? e.message : "Couldn't duplicate."));
				},
				onDelete: () => setPending({ kind: "delete" }),
				onSetStatus: (status) => edit(playlistId, { type: "setStatus", status }),
				quitItem,
			}),
			documentEditMenu({
				mode: state.mode,
				onSetMode: (mode) => edit(playlistId, { type: "setMode", mode }),
				addItems: addMenuItems(ADD_ACTIONS, runAdd),
			}),
			documentControlMenu({
				lock: locks[playlistId] ?? { clock: false, busy: false },
				onToggleClock: () => void toggleClockLock(playlistId),
			}),
			windowMenu({
				onFocusTools,
				onFocusList,
				onFocusDocument,
				documents: openIds.map((id) => ({ playlistId: id, title: states[id]?.title ?? "" })),
			}),
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[state, locks, openIds, states, playlistId, quitItem],
	);

	if (!state) return null;

	const alert = (() => {
		if (lockError?.playlistId === playlistId) {
			return (
				<ClassicyAlert
					id={`${windowId}_lock_error`} appId={appId} alertType="stop"
					title="Control" label={lockError.message}
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: dismissLockError }]}
					onClose={dismissLockError}
				/>
			);
		}
		if (error) {
			return (
				<ClassicyAlert
					id={`${windowId}_error`} appId={appId} alertType="stop"
					title="Playlists" label={error}
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: () => setError(null) }]}
					onClose={() => setError(null)}
				/>
			);
		}
		if (pending?.kind === "delete") {
			return (
				<ClassicyAlert
					id={`${windowId}_delete`} appId={appId} alertType="caution"
					title="Playlists" label={`Delete "${state.title}"? This cannot be undone.`}
					// HIG: on an action that risks data loss the SAFE button is
					// the default, so Return dismisses rather than destroys.
					defaultButtonId="cancel"
					buttons={[
						{ id: "cancel", label: "Cancel", role: "cancel", onClick: () => setPending(null) },
						{
							id: "delete", label: "Delete", role: "normal",
							onClick: () => {
								void deletePlaylist(playlistId)
									.then(() => closePlaylist(playlistId))
									.catch((e) => {
										setPending(null);
										setError(e instanceof Error ? e.message : "Couldn't delete.");
									});
							},
						},
					]}
					onClose={() => setPending(null)}
				/>
			);
		}
		if (pending?.kind === "close") {
			return (
				<ClassicyAlert
					id={`${windowId}_close`} appId={appId} alertType="caution"
					title="Playlists" label={`Save changes to "${state.title}" before closing?`}
					buttons={[
						{ id: "save", label: "Save", role: "default", onClick: save },
						{
							id: "dont", label: "Don't Save", role: "normal",
							onClick: () => { setPending(null); closePlaylist(playlistId); },
						},
						{ id: "cancel", label: "Cancel", role: "cancel", onClick: () => setPending(null) },
					]}
					onClose={() => setPending(null)}
				/>
			);
		}
		if (prompt.kind === "message") {
			return (
				<ClassicyAlert
					id={`${windowId}_save_msg`} appId={appId} alertType="stop"
					title="Playlists" label={prompt.message}
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: dismiss }]}
					onClose={dismiss}
				/>
			);
		}
		if (prompt.kind === "dropped") {
			return (
				<ClassicyAlert
					id={`${windowId}_save_dropped`} appId={appId} alertType="stop"
					title="Playlists"
					label="Some entries are incomplete and would be lost — fix them before saving."
					message={<ul>{prompt.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: dismiss }]}
					onClose={dismiss}
				/>
			);
		}
		if (prompt.kind === "warnings") {
			return (
				<ClassicyAlert
					id={`${windowId}_save_warn`} appId={appId} alertType="caution"
					title="Playlists" label="This playlist has warnings."
					message={<ul>{prompt.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
					buttons={[
						{ id: "anyway", label: "Save Anyway", role: "default", onClick: confirmSave },
						{ id: "keep", label: "Keep Editing", role: "cancel", onClick: dismiss },
					]}
					onClose={dismiss}
				/>
			);
		}
		return null;
	})();

	return (
		<>
			<ClassicyWindow
				id={windowId}
				appId={appId}
				title={state.title}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				collapsable={false}
				scrollable={true}
				initialSize={[640, 480]}
				initialPosition={[140 + index * CASCADE, 90 + index * CASCADE]}
				appMenu={appMenu}
				onCloseFunc={() => {
					if (!state.dirty) {
						closePlaylist(playlistId);
						return;
					}
					setPending({ kind: "close" });
				}}
			>
				<PlaylistEditorMain state={state} edit={edit} />
			</ClassicyWindow>
			{alert}
			{renaming && (
				<RenameDialog
					appId={appId}
					icon={appIcon}
					initialTitle={state.title}
					onRename={(title) => {
						setRenaming(false);
						// Title-only patch: updatePlaylist takes a partial, so
						// renaming never persists unsaved definition edits as a
						// side effect. `renamed` (not setTitle) keeps the
						// document's dirty flag untouched, since the title it
						// carries is already saved.
						void updatePlaylist(playlistId, { title })
							.then(() => edit(playlistId, { type: "renamed", title }))
							.catch((e) => setError(e instanceof Error ? e.message : "Couldn't rename."));
					}}
					onCancel={() => setRenaming(false)}
				/>
			)}
		</>
	);
}
