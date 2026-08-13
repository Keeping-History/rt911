import {
	ClassicyAlert, type ClassicyMenuItem, ClassicyWindow, useAppManager, useAppManagerDispatch,
} from "classicy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
		states, openIds, locks, lockError, openTicks, edit, setActive, closePlaylist,
		openPlaylist, toggleClockLock, dismissLockError, setDialogMode, refreshList,
	} = usePlaylistEditor();
	const state = states[playlistId];
	const windowId = `playlist_doc_${playlistId}`;
	const dispatch = useAppManagerDispatch();

	const [pending, setPending] = useState<Pending>(null);
	const [renaming, setRenaming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Open THEN focus, the same idiom PlaylistEditor's `reveal` uses:
	// ClassicyWindowFocus does not clear `closed`, so focusing a window the
	// close box just closed would leave it off screen.
	const revealSelf = useCallback(() => {
		dispatch({ type: "ClassicyWindowOpen", app: { id: appId }, window: { id: windowId } });
		dispatch({ type: "ClassicyWindowFocus", app: { id: appId }, window: { id: windowId } });
	}, [dispatch, appId, windowId]);

	/**
	 * Take the window out of classicy's store. Unmounting is not enough:
	 * classicy self-destroys only MODAL windows on unmount, so an ordinary
	 * document would linger as `closed: false, focused: true` and the menu bar
	 * would keep serving this document's File/Edit/Control menus — whose
	 * closures still run, PATCHing a deleted id. Closing lets the reducer
	 * refocus the next non-utility window and correct the bar.
	 */
	const dismissWindow = useCallback(() => {
		dispatch({ type: "ClassicyWindowClose", app: { id: appId }, window: { id: windowId } });
	}, [dispatch, appId, windowId]);

	// Raise this window whenever the provider is asked to open this playlist —
	// including on mount, and including a reopen into a store entry that
	// already exists (where ClassicyWindowOpen only clears `closed`). The
	// window's own ClassicyWindow child has already registered itself by the
	// time this parent effect runs, so the store entry is guaranteed to exist.
	const hasState = state !== undefined;
	const openTick = openTicks[playlistId] ?? 0;
	useEffect(() => {
		if (!hasState) return;
		revealSelf();
	}, [hasState, openTick, revealSelf]);

	/**
	 * Set when Save is chosen from the dirty-close prompt, so the save's
	 * success path — and only its success path — finishes the close the user
	 * asked for. A ref rather than state because it is read inside the save
	 * callback, never rendered.
	 */
	const closeAfterSave = useRef(false);

	const { prompt, save, confirmSave, dismiss } = useSavePlaylist(state, () => {
		edit(playlistId, { type: "markSaved" });
		refreshList();
		if (closeAfterSave.current) {
			closeAfterSave.current = false;
			dismissWindow();
			closePlaylist(playlistId);
		}
	});

	// Abandoning the save abandons the close it was going to finish; otherwise
	// the flag would survive to close the window on some later, unrelated save.
	const dismissSave = () => {
		closeAfterSave.current = false;
		dismiss();
	};

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
		() => {
			// `state` can briefly be missing on the render where a window
			// mounts before its EditorStates entry lands (not reachable from
			// this provider today — it batches `openIds` and `states` together
			// — but this memo runs before the `if (!state) return null` guard
			// below, so it must not assume `state` is defined).
			if (!state) return [];
			return [
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
							.then((copy) => {
								openPlaylist(copy);
								refreshList();
							})
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
			];
		},
		// `edit`, `openPlaylist`, `refreshList`, and `toggleClockLock` come from
		// PlaylistEditorProvider: `edit`/`openPlaylist`/`refreshList` are
		// useCallbacks with an empty dep array (stable for the component's
		// whole lifetime), and
		// `toggleClockLock`'s deps are `locks` (already listed below) and
		// `sendLock`, a stable default-parameter reference to the
		// module-level `sendRoomLock` — so none of the three can go stale
		// without a listed dep also changing. `save` and `runAdd` ARE rebuilt
		// on every render (save's chain bottoms out in an unmemoized
		// `onSaved` closure passed to useSavePlaylist; `runAdd` is a plain,
		// unmemoized closure), so no dep
		// array could keep them "fresh" relative to this memo — but both close
		// only over values already listed below (`state`, `playlistId`,
		// `edit`), so an older captured copy behaves identically to a newer
		// one. Listing all five would make this memo recompute on every
		// render, which defeats the point of memoizing it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[
			state, locks, openIds, states, playlistId, quitItem,
			onOpenList, onFocusTools, onFocusList, onFocusDocument,
		],
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
									.then(() => {
										dismissWindow();
										closePlaylist(playlistId);
										refreshList();
									})
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
						{
							id: "save", label: "Save", role: "default",
							onClick: () => { closeAfterSave.current = true; save(); },
						},
						{
							id: "dont", label: "Don't Save", role: "normal",
							// The close box's own close was undone when the prompt
							// re-asserted the window, so this has to close it again
							// — otherwise unmounting alone would strand a focused
							// entry in the store.
							onClick: () => {
								setPending(null);
								dismissWindow();
								closePlaylist(playlistId);
							},
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
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: dismissSave }]}
					onClose={dismissSave}
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
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: dismissSave }]}
					onClose={dismissSave}
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
						{ id: "keep", label: "Keep Editing", role: "cancel", onClick: dismissSave },
					]}
					onClose={dismissSave}
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
					// The close box has ALREADY set `closed: true` in the store
					// by the time this runs, so without re-asserting the window
					// the prompt would be asking about a document the user can
					// no longer see — and Cancel would leave it invisible but
					// open. Put it back first; Cancel is then a true no-op.
					revealSelf();
					setPending({ kind: "close" });
				}}
			>
				<PlaylistEditorMain state={state} edit={edit} />
			</ClassicyWindow>
			{alert}
			{renaming && (
				<RenameDialog
					appId={appId}
					playlistId={playlistId}
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
							.then(() => {
								edit(playlistId, { type: "renamed", title });
								refreshList();
							})
							.catch((e) => setError(e instanceof Error ? e.message : "Couldn't rename."));
					}}
					onCancel={() => setRenaming(false)}
				/>
			)}
		</>
	);
}
