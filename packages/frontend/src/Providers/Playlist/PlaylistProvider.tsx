// Non-persisted playlist runtime. Lives OUTSIDE ClassicyStore/localStorage/
// ClassicyFileSystem by construction — Empty Trash and store resets can't
// touch it; a refresh re-fetches from Directus.
//
// Two enforcement styles, mirroring the engine split:
//   evaluate()        → state, reconciled by diffing successive snapshots
//   collectCrossings() → events, fired only when the clock TICKS across `at`
// (jumps and manual seeks never retro-fire skipped triggers; rewinding behind
// a trigger re-arms it — see the design spec's trigger semantics).
import {
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
	type ActionMessage,
} from "classicy";
import {
	type FC,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { browserNavigate } from "../../Applications/Browser/BrowserContext";
import { flightTrackerFocusFlight } from "../../Applications/FlightTracker/flightTrackerCommands";
import { newsFocusItem } from "../../Applications/News/NewsContext";
import { radioTuneStation } from "../../Applications/RadioScanner/RadioScannerContext";
import { BROADCAST_STATIONS } from "../../Applications/RadioScanner/stationGrouping";
import { radioTunerTuneStation } from "../../Applications/RadioTuner/RadioTunerContext";
import { setDateTimeFromUtc } from "../../Applications/TimeMachine/setVirtualClock";
import { tvTuneChannel } from "../../Applications/TV/TVContext";
import { virtualUtcMs } from "../MediaStream/virtualClock";
import {
	collectCrossings,
	evaluate,
	initialFocusEvents,
	type RulesSnapshot,
	type TriggerEvent,
} from "./playlistEngine";
import { loadPlaylist, playlistIdFromSearch } from "./loadPlaylist";
import {
	PERMISSION_DENIED,
	playlistAppMeta,
	playlistFocusAppId,
} from "./playlistApps";
import { PlaylistContext, type PlaylistContextValue } from "./PlaylistContext";
import { playlistMergeAppData } from "./playlistStoreActions";
import type { PlaylistApp, PlaylistDefinition } from "./playlistTypes";

// Matches MediaStreamProvider's SEEK_THRESHOLD_MS: a move larger than this is a
// manual seek (or a playlist jump landing), not a tick — fire nothing.
const SEEK_THRESHOLD_MS = 90_000;

type Dispatch = (action: ActionMessage) => void;

// How each catalog's owning app is told "focus this item". TV ships wired;
// radio/news/flights/browser are replaced by their per-app tasks (plan Tasks
// 8–11) — until then a scheduled focus logs instead of silently vanishing.
const FOCUS_DISPATCHERS: Record<PlaylistApp | "browser", (d: Dispatch, itemId: string) => void> =
	{
		tv: (d, itemId) => d(tvTuneChannel(itemId)),
		// The radio catalog spans two apps post-split: broadcast stations tune
		// the Radio Tuner, comm-traffic stations the Radio Scanner — matching
		// playlistFocusAppId's app choice.
		radio: (d, itemId) =>
			d(
				BROADCAST_STATIONS.has(itemId.toUpperCase())
					? radioTunerTuneStation(itemId)
					: radioTuneStation(itemId),
			),
		news: (d, itemId) => d(newsFocusItem(Number(itemId))),
		flights: (d, itemId) => d(flightTrackerFocusFlight(itemId)),
		browser: (d, url) => d(browserNavigate(url)),
	};

export const PlaylistProvider: FC<{ children: ReactNode }> = ({ children }) => {
	const dispatch = useAppManagerDispatch();
	// tick: true = per-second updates; the bare hook may tick per-minute (the
	// menu-bar clock cadence) and windows/triggers need 1 s resolution.
	const { localDate, tzOffset, setDateTime } = useClassicyDateTime({ tick: true });
	const apps = useAppManager((s) => s.System.Manager.Applications.apps) as Record<
		string,
		{ open?: boolean; data?: Record<string, unknown> }
	>;
	// Cross-provider signal from MediaStreamProvider (which sits below this
	// provider and can't be read via context): the central forced clock
	// outranks playlist scheduling, so jump crossings are suppressed while set.
	const dateTimeLocked = useAppManager((s) => s.System.Manager.DateAndTime.dateTimeLocked);

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
	// Ref mirror so event appliers read the freshest snapshot without joining
	// every effect's dependency list.
	const snapshotRef = useRef<RulesSnapshot>(snapshot);
	snapshotRef.current = snapshot;

	// Open the owning app (unless disabled — disable wins) and tune it.
	const applyFocus = useCallback(
		(e: Extract<TriggerEvent, { kind: "focus" }>): void => {
			const appId = playlistFocusAppId(e.app, e.itemId);
			if (snapshotRef.current.disabledApps.has(appId)) return;
			dispatch({ type: "ClassicyAppOpen", app: { id: appId, ...playlistAppMeta(appId) } });
			FOCUS_DISPATCHERS[e.app](dispatch, e.itemId);
		},
		[dispatch],
	);

	// --- Events: tick/seek discrimination + crossings ----------------------
	const prevMsRef = useRef<number | null>(null);
	useEffect(() => {
		if (!definition) return;
		const prev = prevMsRef.current;
		prevMsRef.current = nowMs;
		if (prev === null) {
			// Activation: fire focus entries whose window contains now (covers
			// refresh / late join and entries with no start).
			for (const e of initialFocusEvents(definition, nowMs)) {
				if (e.kind === "focus") applyFocus(e);
			}
			return;
		}
		if (Math.abs(nowMs - prev) > SEEK_THRESHOLD_MS) return; // seek: re-arm only
		for (const e of collectCrossings(definition, prev, nowMs)) {
			if (e.kind === "jump") {
				// Central forced clock outranks playlist scheduling; the server
				// would clamp the seek anyway — don't fight it client-side.
				if (dateTimeLocked) continue;
				setDateTimeFromUtc(setDateTime, e.to);
				// The clock moved; remaining same-tick events are in skipped territory.
				break;
			}
			if (e.kind === "file") {
				dispatch({ type: "ClassicyAppFinderOpenFile", path: e.path });
			}
			if (e.kind === "focus") applyFocus(e);
		}
	}, [definition, nowMs, dispatch, setDateTime, applyFocus, dateTimeLocked]);

	// --- State: app gating watcher -----------------------------------------
	// Reactive close-on-open rather than action interception: classicy's
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

	// --- State: browser desired-state transitions ---------------------------
	// Acting only on TRANSITIONS means a student who hand-closes the Browser
	// mid-window is respected; the next scheduled change re-drives it.
	const prevBrowserRef = useRef<RulesSnapshot["browserShouldBe"]>({ open: false });
	useEffect(() => {
		if (!definition) return;
		const prev = prevBrowserRef.current;
		const next = snapshot.browserShouldBe;
		prevBrowserRef.current = next;
		const meta = playlistAppMeta("Browser.app");
		if (next.open && (!prev.open || prev.url !== next.url)) {
			dispatch({ type: "ClassicyAppOpen", app: { id: "Browser.app", ...meta } });
			FOCUS_DISPATCHERS.browser(dispatch, next.url);
		} else if (!next.open && prev.open) {
			dispatch({ type: "ClassicyAppClose", app: { id: "Browser.app", ...meta } });
		}
	}, [definition, snapshot, dispatch]);

	// --- State: settings — one boot seed, then locked reconciliation --------
	// The seed overrides both app defaults and the student's persisted state so
	// every student starts the lesson identically.
	const settingsSeededRef = useRef(false);
	useEffect(() => {
		if (!definition || settingsSeededRef.current) return;
		settingsSeededRef.current = true;
		for (const e of definition.entries) {
			if (e.kind === "settings") dispatch(playlistMergeAppData(e.appId, e.values));
		}
	}, [definition, dispatch]);

	useEffect(() => {
		if (!definition) return;
		for (const [appId, values] of snapshot.lockedSettings) {
			const data = apps[appId]?.data ?? {};
			const diverged = Object.entries(values).filter(
				([k, v]) => JSON.stringify(data[k]) !== JSON.stringify(v),
			);
			if (diverged.length > 0) {
				dispatch(playlistMergeAppData(appId, Object.fromEntries(diverged)));
			}
		}
	}, [definition, snapshot, apps, dispatch]);

	// --- State: locked-focus reconciliation ----------------------------------
	// Each participating app publishes its current selection into its store
	// data (contract: TV.currentChannel, RadioScanner/RadioTuner.activeStation,
	// News.openDocuments, FlightTracker.focusedFlight).
	useEffect(() => {
		if (!definition) return;
		for (const [app, itemId] of snapshot.lockedFocus) {
			const appId = playlistFocusAppId(app, itemId);
			const data = apps[appId]?.data ?? {};
			const current =
				app === "tv"
					? (data.currentChannel as string | undefined)
					: app === "radio"
						? (data.activeStation as string | undefined)
						: app === "flights"
							? (data.focusedFlight as string | undefined)
							: undefined; // news uses openDocuments below
			const inPlace =
				app === "news"
					? ((data.openDocuments as number[] | undefined) ?? []).includes(Number(itemId))
					: current?.toLowerCase() === itemId.toLowerCase();
			if (!inPlace) FOCUS_DISPATCHERS[app](dispatch, itemId);
		}
	}, [definition, snapshot, apps, dispatch]);

	/**
	 * The student end of a teacher's "Push Update to Class" (`reload` room
	 * command, applied by RoomControlBridge): re-fetch the published definition
	 * and swap it in live.
	 *
	 * The swap is treated as a fresh activation — `prevMsRef` resets so the
	 * next tick fires the new definition's in-window focus entries (exactly
	 * what a student joining fresh would get from `initialFocusEvents`), and
	 * `settingsSeededRef` resets so newly pushed settings entries seed instead
	 * of silently doing nothing. `evaluate()` is a pure function of
	 * (definition, clock), so every state effect above reconciles on its own.
	 * Room lock state (`dateTimeLocked`) is deliberately untouched: a
	 * definition refresh must not unlock a locked classroom.
	 *
	 * Fails open the QUIET way: mid-lesson, a flaky re-fetch keeps the current
	 * definition rather than tearing the lesson down with an error dialog —
	 * unlike the initial load, the student already has a working playlist.
	 * Serialized via `reloadInFlightRef`: loadPlaylist must never run
	 * concurrently with itself (parallel same-path api-beta fetches can return
	 * mixed bodies — see loadPlaylist.ts), and a burst of reload commands
	 * collapses into one fetch of the same final definition anyway.
	 */
	const reloadInFlightRef = useRef(false);
	const reloadDefinition = useCallback(() => {
		const id = playlistIdFromSearch(window.location.search);
		if (!id || reloadInFlightRef.current) return;
		reloadInFlightRef.current = true;
		loadPlaylist(id)
			.then((loaded) => {
				prevMsRef.current = null;
				settingsSeededRef.current = false;
				setDefinition(loaded.definition);
				setTitle(loaded.title);
			})
			.catch((err) => {
				console.warn("playlist reload failed:", err);
			})
			.finally(() => {
				reloadInFlightRef.current = false;
			});
	}, []);

	const value = useMemo<PlaylistContextValue>(
		() => ({
			active: definition !== null,
			title,
			isItemAvailable: snapshot.isItemAvailable,
			reloadDefinition,
		}),
		[definition, title, snapshot, reloadDefinition],
	);

	return <PlaylistContext.Provider value={value}>{children}</PlaylistContext.Provider>;
};
