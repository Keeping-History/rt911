import { createContext, useContext } from "react";
import type { PlaylistApp } from "./playlistTypes";

export interface PlaylistContextValue {
	active: boolean;
	title: string | null;
	isItemAvailable: (app: PlaylistApp, itemId: string) => boolean;
	/**
	 * Re-fetch the published definition and re-evaluate it — the student end of
	 * a teacher's "Push Update to Class" (a `reload` room command, applied by
	 * RoomControlBridge). A failed re-fetch keeps the current definition; it
	 * never touches room lock state.
	 */
	reloadDefinition: () => void;
}

// Default = no playlist: everything allowed. MediaStreamProvider consumes this
// default in tests that mount it without a PlaylistProvider.
export const PlaylistContext = createContext<PlaylistContextValue>({
	active: false,
	title: null,
	isItemAvailable: () => true,
	reloadDefinition: () => {},
});

export const usePlaylist = (): PlaylistContextValue => useContext(PlaylistContext);
