// A persisted Classicy window entry, narrowed to just the fields we need to
// decide whether it should be visible. Classicy stores the full window object
// (position, size, focus, …) but only `id` and `closed` matter for restoration.
interface PersistedWindow {
	id: string;
	closed?: boolean;
}

/**
 * True when a window with `windowId` is present in the persisted store and not
 * closed. Used to seed TimeMachine's `showSettings`/`showBookmarks` React state
 * on mount so windows that were open before a browser reload reappear — Classicy
 * persists the window entry, but the app's own visibility flag would otherwise
 * reset to false, orphaning the persisted (and focused) window.
 */
export const isWindowOpen = (
	windows: PersistedWindow[] | undefined,
	windowId: string,
): boolean => !!windows?.some((w) => w.id === windowId && !w.closed);
