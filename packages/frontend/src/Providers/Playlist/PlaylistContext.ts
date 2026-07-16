import { createContext, useContext } from "react";
import type { PlaylistApp } from "./playlistTypes";

export interface PlaylistContextValue {
	active: boolean;
	title: string | null;
	isItemAvailable: (app: PlaylistApp, itemId: string) => boolean;
}

// Default = no playlist: everything allowed. MediaStreamProvider consumes this
// default in tests that mount it without a PlaylistProvider.
export const PlaylistContext = createContext<PlaylistContextValue>({
	active: false,
	title: null,
	isItemAvailable: () => true,
});

export const usePlaylist = (): PlaylistContextValue => useContext(PlaylistContext);
