import { useAppManagerDispatch } from "classicy";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useReducer, useRef, useState } from "react";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import { RoomCommandError, sendRoomLock } from "../../Providers/Playlist/roomApi";
import type { EditorAction } from "./editorState";
import { editorStatesReducer, type EditorStates } from "./editorStates";

/** Per-playlist room lock state. Not read back from the server — see below. */
export interface LockState {
	clock: boolean;
	busy: boolean;
}

export interface PlaylistEditorContextValue {
	states: EditorStates;
	/** Open documents, in the order they were opened; drives window cascade. */
	openIds: string[];
	/** The last-focused document window's playlist id. */
	activeId: string | null;
	locks: Record<string, LockState>;
	lockError: { playlistId: string; message: string } | null;
	dialogMode: "media" | "file" | null;
	/**
	 * Bumped every time `openPlaylist` runs, per playlist. The document window
	 * watches its own entry and raises itself, which is what makes reopening an
	 * already-open (or previously closed) document come to the front:
	 * `ClassicyWindowOpen` on an id the store already knows only clears
	 * `closed`, it does not focus, so without this a reopened document could
	 * come up behind the list window.
	 */
	openTicks: Record<string, number>;
	/**
	 * Bumped whenever something outside the list window changes what the list
	 * should show (create, save, rename, duplicate, delete). The
	 * list window refetches when it changes — it now never unmounts, so it has
	 * no other moment at which to notice.
	 */
	listVersion: number;
	refreshList: () => void;
	openPlaylist: (record: PlaylistRecord) => void;
	/**
	 * Drop a document's editor state. Use this only when classicy has ALREADY
	 * closed the window itself — i.e. from a window's own close box, which sets
	 * `closed: true` before `onCloseFunc` runs. Anywhere else, see
	 * `closePlaylistWindow`.
	 */
	closePlaylist: (playlistId: string) => void;
	/**
	 * Close a document the app itself decided to close: drop its editor state AND
	 * take its window out of classicy's store. Both halves are required, because
	 * classicy self-destroys only MODAL windows on unmount — an ordinary document
	 * would linger as `closed: false, focused: true` and the menu bar would keep
	 * serving its File/Edit/Control menus, whose closures still act on the
	 * playlist (Save PATCHes it, Control sends a room command for it). Shared by
	 * both delete paths and by the dirty-close prompt.
	 */
	closePlaylistWindow: (playlistId: string) => void;
	setActive: (playlistId: string) => void;
	edit: (playlistId: string, action: EditorAction) => void;
	toggleClockLock: (playlistId: string) => Promise<void>;
	dismissLockError: () => void;
	setDialogMode: (mode: "media" | "file" | null) => void;
}

const PlaylistEditorContext = createContext<PlaylistEditorContextValue | null>(null);

export function usePlaylistEditor(): PlaylistEditorContextValue {
	const ctx = useContext(PlaylistEditorContext);
	if (!ctx) throw new Error("usePlaylistEditor must be used inside PlaylistEditorProvider");
	return ctx;
}

export function PlaylistEditorProvider({
	children,
	appId,
	/** Injectable for tests; defaults to the real API call. */
	sendLock = sendRoomLock,
}: {
	children: ReactNode;
	/** The owning ClassicyApp, so `closePlaylistWindow` can address its windows. */
	appId: string;
	sendLock?: typeof sendRoomLock;
}) {
	const [states, dispatchStates] = useReducer(editorStatesReducer, {});
	const [openIds, setOpenIds] = useState<string[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [locks, setLocks] = useState<Record<string, LockState>>({});
	const [lockError, setLockError] = useState<{ playlistId: string; message: string } | null>(null);
	const [dialogMode, setDialogMode] = useState<"media" | "file" | null>(null);
	const [openTicks, setOpenTicks] = useState<Record<string, number>>({});
	const [listVersion, setListVersion] = useState(0);

	const refreshList = useCallback(() => setListVersion((v) => v + 1), []);

	const openPlaylist = useCallback((record: PlaylistRecord) => {
		dispatchStates({ kind: "open", record });
		setOpenIds((ids) => (ids.includes(record.id) ? ids : [...ids, record.id]));
		// Opening focuses, which is also what makes a freshly duplicated
		// playlist the palette's target.
		setActiveId(record.id);
		// Raising the window is the document window's job — it is the only
		// component that knows the window exists in classicy's store yet.
		setOpenTicks((t) => ({ ...t, [record.id]: (t[record.id] ?? 0) + 1 }));
	}, []);

	const closePlaylist = useCallback((playlistId: string) => {
		dispatchStates({ kind: "close", playlistId });
		setOpenIds((ids) => ids.filter((id) => id !== playlistId));
		setActiveId((current) => (current === playlistId ? null : current));
	}, []);

	// `playlist_doc_<id>` is PlaylistDocumentWindow's own `windowId` — this is the
	// one place outside that component that has to name it.
	const dispatch = useAppManagerDispatch();
	const closePlaylistWindow = useCallback(
		(playlistId: string) => {
			dispatch({
				type: "ClassicyWindowClose",
				app: { id: appId },
				window: { id: `playlist_doc_${playlistId}` },
			});
			closePlaylist(playlistId);
		},
		[dispatch, appId, closePlaylist],
	);

	const setActive = useCallback((playlistId: string) => setActiveId(playlistId), []);

	const edit = useCallback((playlistId: string, action: EditorAction) => {
		dispatchStates({ kind: "edit", playlistId, action });
	}, []);

	/**
	 * Lock state is held here rather than read back from the server, because
	 * the streamer keeps none: a room command is fire-and-forget, so there is
	 * nothing to query. Two consequences worth knowing: the checkmark resets
	 * when the app is reopened (students stay locked — only the menu forgets),
	 * and two teachers driving one playlist will not see each other's state.
	 *
	 * `busy` in `LockState` is a display flag for consumers (disable the menu
	 * item) — it is NOT what guards against a second invocation for the same
	 * playlist landing while the first is still in flight. React state can't
	 * be read synchronously, so a functional `setLocks` can't serve as that
	 * guard: two calls in the same tick (or one arriving through a stale
	 * `toggleClockLock` reference a consumer's own memo failed to refresh)
	 * would both see `busy === false` and both call `sendLock`. `inFlight`
	 * closes that gap with a synchronous check-and-add before the `await`.
	 * With multiple document windows plus the palette all able to reach this
	 * function for the same document, that surface is wide enough to hit.
	 */
	const inFlight = useRef<Set<string>>(new Set());

	const toggleClockLock = useCallback(
		async (playlistId: string) => {
			if (inFlight.current.has(playlistId)) return;
			inFlight.current.add(playlistId);
			try {
				const current = locks[playlistId] ?? { clock: false, busy: false };
				const next = !current.clock;
				setLocks((l) => ({ ...l, [playlistId]: { clock: (l[playlistId] ?? current).clock, busy: true } }));
				setLockError(null);
				try {
					await sendLock(playlistId, "clock", next);
					// Only after the server accepts. Flipping first would leave the
					// menu claiming a lock that never reached a single student.
					// Read fresh from `l` rather than the closed-over `current` so a
					// concurrent change to this playlist's entry (from elsewhere)
					// can't be clobbered by this call's stale snapshot.
					setLocks((l) => ({ ...l, [playlistId]: { clock: next, busy: false } }));
				} catch (err) {
					setLocks((l) => ({
						...l,
						[playlistId]: { clock: (l[playlistId] ?? current).clock, busy: false },
					}));
					setLockError({
						playlistId,
						message: err instanceof RoomCommandError ? err.message : "Command failed.",
					});
				}
			} finally {
				inFlight.current.delete(playlistId);
			}
		},
		[locks, sendLock],
	);

	const dismissLockError = useCallback(() => setLockError(null), []);

	const value = useMemo<PlaylistEditorContextValue>(
		() => ({
			states, openIds, activeId, locks, lockError, dialogMode, openTicks,
			listVersion, refreshList,
			openPlaylist, closePlaylist, closePlaylistWindow, setActive, edit,
			toggleClockLock, dismissLockError, setDialogMode,
		}),
		[
			states, openIds, activeId, locks, lockError, dialogMode, openTicks,
			listVersion, refreshList,
			openPlaylist, closePlaylist, closePlaylistWindow, setActive, edit,
			toggleClockLock, dismissLockError,
		],
	);

	return (
		<PlaylistEditorContext.Provider value={value}>{children}</PlaylistEditorContext.Provider>
	);
}
