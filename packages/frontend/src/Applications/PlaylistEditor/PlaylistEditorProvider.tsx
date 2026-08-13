import { createContext, type ReactNode, useCallback, useContext, useMemo, useReducer, useState } from "react";
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
	openPlaylist: (record: PlaylistRecord) => void;
	closePlaylist: (playlistId: string) => void;
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
	/** Injectable for tests; defaults to the real API call. */
	sendLock = sendRoomLock,
}: {
	children: ReactNode;
	sendLock?: typeof sendRoomLock;
}) {
	const [states, dispatchStates] = useReducer(editorStatesReducer, {});
	const [openIds, setOpenIds] = useState<string[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [locks, setLocks] = useState<Record<string, LockState>>({});
	const [lockError, setLockError] = useState<{ playlistId: string; message: string } | null>(null);
	const [dialogMode, setDialogMode] = useState<"media" | "file" | null>(null);

	const openPlaylist = useCallback((record: PlaylistRecord) => {
		dispatchStates({ kind: "open", record });
		setOpenIds((ids) => (ids.includes(record.id) ? ids : [...ids, record.id]));
		// Opening focuses, which is also what makes a freshly duplicated
		// playlist the palette's target.
		setActiveId(record.id);
	}, []);

	const closePlaylist = useCallback((playlistId: string) => {
		dispatchStates({ kind: "close", playlistId });
		setOpenIds((ids) => ids.filter((id) => id !== playlistId));
		setActiveId((current) => (current === playlistId ? null : current));
	}, []);

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
	 */
	const toggleClockLock = useCallback(
		async (playlistId: string) => {
			const current = locks[playlistId] ?? { clock: false, busy: false };
			if (current.busy) return;
			const next = !current.clock;
			setLocks((l) => ({ ...l, [playlistId]: { ...current, busy: true } }));
			setLockError(null);
			try {
				await sendLock(playlistId, "clock", next);
				// Only after the server accepts. Flipping first would leave the
				// menu claiming a lock that never reached a single student.
				setLocks((l) => ({ ...l, [playlistId]: { clock: next, busy: false } }));
			} catch (err) {
				setLocks((l) => ({ ...l, [playlistId]: { ...current, busy: false } }));
				setLockError({
					playlistId,
					message: err instanceof RoomCommandError ? err.message : "Command failed.",
				});
			}
		},
		[locks, sendLock],
	);

	const dismissLockError = useCallback(() => setLockError(null), []);

	const value = useMemo<PlaylistEditorContextValue>(
		() => ({
			states, openIds, activeId, locks, lockError, dialogMode,
			openPlaylist, closePlaylist, setActive, edit,
			toggleClockLock, dismissLockError, setDialogMode,
		}),
		[
			states, openIds, activeId, locks, lockError, dialogMode,
			openPlaylist, closePlaylist, setActive, edit, toggleClockLock, dismissLockError,
		],
	);

	return (
		<PlaylistEditorContext.Provider value={value}>{children}</PlaylistEditorContext.Provider>
	);
}
