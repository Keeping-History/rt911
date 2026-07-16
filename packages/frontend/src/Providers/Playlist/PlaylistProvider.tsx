// Non-persisted playlist runtime. Lives OUTSIDE ClassicyStore/localStorage/
// ClassicyFileSystem by construction — Empty Trash and store resets can't
// touch it; a refresh re-fetches from Directus.
import { useAppManager, useAppManagerDispatch, useClassicyDateTime } from "classicy";
import { type FC, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { virtualUtcMs } from "../MediaStream/virtualClock";
import { evaluate } from "./playlistEngine";
import { loadPlaylist, playlistIdFromSearch } from "./loadPlaylist";
import { PERMISSION_DENIED, playlistAppMeta } from "./playlistApps";
import { PlaylistContext, type PlaylistContextValue } from "./PlaylistContext";
import type { PlaylistDefinition } from "./playlistTypes";

export const PlaylistProvider: FC<{ children: ReactNode }> = ({ children }) => {
	const dispatch = useAppManagerDispatch();
	// tick: true = per-second updates; the bare hook may tick per-minute (the
	// menu-bar clock cadence) and windows/triggers need 1 s resolution.
	const { localDate, tzOffset } = useClassicyDateTime({ tick: true });
	const apps = useAppManager((s) => s.System.Manager.Applications.apps) as Record<
		string,
		{ open?: boolean; data?: Record<string, unknown> }
	>;

	const [definition, setDefinition] = useState<PlaylistDefinition | null>(null);
	const [title, setTitle] = useState<string | null>(null);
	const bootSweepDoneRef = useRef(false);

	// Load once at mount (StrictMode double-mount guarded by the ref).
	const loadStartedRef = useRef(false);
	useEffect(() => {
		if (loadStartedRef.current) return;
		loadStartedRef.current = true;
		const id = playlistIdFromSearch(window.location.search);
		if (!id) return;
		loadPlaylist(id)
			.then((loaded) => {
				setDefinition(loaded.definition);
				setTitle(loaded.title);
			})
			.catch(() => {
				// Fail-open: a bad link degrades to the normal site, loudly.
				dispatch({
					type: "ClassicyDesktopShowErrorDialog",
					title: "Playlist",
					message: "This playlist could not be loaded.",
				});
			});
	}, [dispatch]);

	const nowMs = virtualUtcMs(localDate, tzOffset);
	const snapshot = useMemo(() => evaluate(definition, nowMs), [definition, nowMs]);

	// App gating: reactive watcher, not action interception — classicy's
	// desktop-icon open path never emits ClassicyAppOpen, so vetoing the action
	// stream would leave a hole. Watching `open` covers every entry point. The
	// first sweep after activation closes silently (stale persisted state).
	useEffect(() => {
		if (!definition) return;
		const silent = !bootSweepDoneRef.current;
		bootSweepDoneRef.current = true;
		for (const appId of snapshot.disabledApps) {
			if (apps[appId]?.open) {
				dispatch({ type: "ClassicyAppClose", app: { id: appId, ...playlistAppMeta(appId) } });
				if (!silent) {
					dispatch({
						type: "ClassicyDesktopShowErrorDialog",
						title: "Playlist",
						message: PERMISSION_DENIED,
					});
				}
			}
		}
	}, [definition, snapshot, apps, dispatch]);

	const value = useMemo<PlaylistContextValue>(
		() => ({
			active: definition !== null,
			title,
			isItemAvailable: snapshot.isItemAvailable,
		}),
		[definition, title, snapshot],
	);

	return <PlaylistContext.Provider value={value}>{children}</PlaylistContext.Provider>;
};
