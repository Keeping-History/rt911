import { type ClassicyStoreSystemAppWindows, getAppWindow } from "classicy";

/**
 * True when a window with `windowId` is present in the persisted store and not
 * closed. Used to seed TimeMachine's `showSettings`/`showBookmarks` React state
 * on mount so windows that were open before a browser reload reappear — Classicy
 * persists the window entry, but the app's own visibility flag would otherwise
 * reset to false, orphaning the persisted (and focused) window.
 *
 * `windows` is the app's window record (`apps[appId].windows`, keyed by window
 * id since Classicy 1.0); only each entry's `closed` flag matters here.
 */
export const isWindowOpen = (
	windows: ClassicyStoreSystemAppWindows | undefined,
	windowId: string,
): boolean => {
	const window = getAppWindow({ windows }, windowId);
	return !!window && !window.closed;
};
