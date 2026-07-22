import {
	ClassicyApp,
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyColorPicker,
	ClassicyControlLabel,
	ClassicyIcons,
	ClassicySlider,
	ClassicyTabs,
	ClassicyWindow,
	MAC_OS_8_CRAYONS,
	QuickTimeVideoEmbed,
	quitMenuItemHelper,
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	MediaItem,
	MediaStreamFilter,
} from "../../Providers/MediaStream/MediaStreamContext";
import { vttUrl } from "../../Providers/MediaStream/MediaStreamContext";
import { useMediaStream } from "../../Providers/MediaStream/useMediaStream";
import styles from "./TV.module.scss";
import {
	type CaptionStyle,
	DEFAULT_CAPTION_STYLE,
	type TVChannelRef,
	type TVRemoteCommand,
	tvPause,
	tvResume,
	tvSetActivePlayer,
	tvSetCaptionState,
	tvSetChannelOrder,
	tvSetCurrentChannel,
	tvSetMuted,
	tvSetVolumeLimit,
} from "./TVContext";
import { moveChannel, orderChannels } from "./channelOrder";
import { useThumbnailReorder } from "./useThumbnailReorder";
import { trackAppToggle, trackChannelChange } from "../../openreplay";
import { bumpToLevel, maybeProbeUp, TV_ABR_CONFIG } from "./abr";
import type { HlsAbrApi } from "./abr";
import { calcSeekSeconds, resolveVirtualNowMs } from "./clockDrift";
import { resolveGridVolume } from "./volume";
import { TVEPGPanel } from "./TVEPGPanel";

/** Resolve a remote channel reference (numeric id or `source` name) to an item id. */
function resolveChannelId(
	channel: TVChannelRef,
	pool: MediaItem[],
): number | undefined {
	if (typeof channel === "number") {
		return pool.find((i) => i.id === channel)?.id;
	}
	const lc = channel.toLowerCase();
	return pool.find((i) => i.source?.toLowerCase() === lc)?.id;
}

// Every approved HLS channel in the stream, before any per-channel selection.
// Hoisted to a module constant so its reference is stable across renders —
// useMediaStream memoizes on the filter object, so an inline literal would
// re-filter on every render.
const ALL_CHANNELS_FILTER: MediaStreamFilter = { format: ["m3u8"], approved: true };

// Caption style options — CSS var names resolved at injection time because
// the ::cue pseudo-element doesn't inherit custom properties from the cascade.
const FONT_VARS: [string, string][] = [
	["--header-font", "Header"],
	["--body-font", "Body"],
	["--ui-font", "UI"],
];

// HLS quality ceilings. hls.js orders levels by ascending bitrate, and the encoder
// ships a fixed 3-rendition ladder (thumb 136k, mid 396k, full 2628k), so:
//   0 = thumb (lowest), 1 = mid (one down), 2 = full (highest).
// These are ABR *ceilings* (autoLevelCapping), not forced levels: the single
// focused video is capped at HIGHEST, a multi-video grid at ONE_DOWN (to keep
// concurrent bandwidth/decoding sane), thumbnails at LOWEST. ABR adapts beneath
// each ceiling, so quality rises and falls gracefully instead of hard-switching.
const QUALITY_LOWEST = 0;
const QUALITY_ONE_DOWN = 1;
const QUALITY_HIGHEST = 2;

type ClassicyTVProps = Record<string, never>;

export const TV: React.FC<ClassicyTVProps> = () => {
	const appName = "TV";
	const appId = "TV.app";
	const appIcon = ClassicyIcons.applications.epg.app as string;

	const desktopEventDispatch = useAppManagerDispatch();
	const appState = useAppManager(
		(state) => state.System.Manager.Applications.apps[appId],
	);

	const isOpen = useAppManager(
		(state) =>
			state.System.Manager.Applications.apps[appId]?.open ?? false,
	);
	const prevIsOpenRef = useRef<boolean | undefined>(undefined);
	useEffect(() => {
		if (prevIsOpenRef.current === undefined) {
			prevIsOpenRef.current = isOpen;
			return;
		}
		if (prevIsOpenRef.current === isOpen) return;
		prevIsOpenRef.current = isOpen;
		trackAppToggle(appId, isOpen ? "open" : "close");
	}, [isOpen]);

	// Unfiltered-by-source list, used only to enumerate which channels exist so
	// Settings can list them all (even ones the user has currently disabled).
	// `sources.video` is the authoritative, time-independent list from the server.
	const { items: allChannelItems, sources } = useMediaStream(ALL_CHANNELS_FILTER);
	const { dateTime, paused: clockPaused } = useClassicyDateTime();

	// Persisted blacklist of channels the user has switched off.
	const disabledChannels = useMemo(
		() => (appState?.data?.disabledChannels as string[] | undefined) ?? [],
		[appState?.data?.disabledChannels],
	);

	// Distinct channel slugs available for selection, sorted for a stable Settings
	// list. Seeded from the server's complete `sources.video` list (every channel,
	// regardless of virtual time) and unioned with anything already seen in-stream
	// so the list is populated even before the `sources` frame arrives.
	const availableChannels = useMemo(() => {
		const seen = new Set<string>(sources.video);
		for (const item of allChannelItems) {
			if (item.source) seen.add(item.source);
		}
		return [...seen].sort();
	}, [allChannelItems, sources.video]);

	// The channels left enabled = everything present minus the blacklist. This is
	// the whitelist handed to the streaming filter below.
	const enabledChannels = useMemo(
		() => availableChannels.filter((c) => !disabledChannels.includes(c)),
		[availableChannels, disabledChannels],
	);

	// The filter actually driving the player grid. Passing `source` here is what
	// "passes the settings through to the streaming filter" — useMediaStream's
	// applyFilter drops any item whose source isn't in the enabled whitelist.
	const tvFilter = useMemo<MediaStreamFilter>(
		() => ({ ...ALL_CHANNELS_FILTER, source: enabledChannels }),
		[enabledChannels],
	);
	const { items } = useMediaStream(tvFilter);

	// The user's drag-ordered channel slugs; empty until the first reorder.
	// Keyed on source, not id — see channelOrder.ts.
	const channelOrder = useMemo(
		() => (appState?.data?.channelOrder as string[] | undefined) ?? [],
		[appState?.data?.channelOrder],
	);
	// Strip order: the user's arrangement first, everything else in the order
	// the stream (or, later, the server) supplies.
	const orderedItems = useMemo(
		() => orderChannels(items, channelOrder),
		[items, channelOrder],
	);
	const handleReorder = useCallback(
		(from: string, to: string) => {
			const visible = orderedItems
				.map((i) => i.source)
				.filter((s): s is string => Boolean(s));
			desktopEventDispatch(tvSetChannelOrder(moveChannel(channelOrder, visible, from, to)));
		},
		[orderedItems, channelOrder, desktopEventDispatch],
	);
	const reorder = useThumbnailReorder(handleReorder);

	// --- Remote-control state, driven by ClassicyAppTV* events (see TVContext) ---
	// Persistent settings, read straight from app data each render.
	// The universal volume ceiling persisted in app data. The slider edits a live
	// local copy (volumeLimit below) so a drag updates audio immediately without
	// dispatching once per tick; the committed value persists on release.
	const persistedVolumeLimit =
		(appState?.data?.volumeLimit as number | undefined) ?? 1;
	const overallMuted = (appState?.data?.overallMuted as boolean | undefined) ?? false;
	// TV-local pause — independent of the global clock, which keeps running so
	// resume can jump forward to live time.
	const tvPaused = (appState?.data?.tvPaused as boolean | undefined) ?? false;
	// One-shot view command (tune / grid / exitGrid), applied once per seq.
	const command = appState?.data?.command as TVRemoteCommand | undefined;

	const [captionsOn, setCaptionsOn] = useState<boolean>(
		(appState?.data?.captionsOn as boolean | undefined) ?? false,
	);
	const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(
		(appState?.data?.captionStyle as CaptionStyle | undefined) ?? DEFAULT_CAPTION_STYLE,
	);
	const [showSettings, setShowSettings] = useState<boolean>(false);
	const [showEpg, setShowEpg] = useState<boolean>(false);
	// Settings form: local working copy of the disabled set, committed on Save.
	const [channelForm, setChannelForm] = useState<string[]>(disabledChannels);
	const [activePlayer, setActivePlayer] = useState<number>(
		(appState?.data?.activePlayer as number | undefined) ?? 0,
	);
	// Publish the active channel's source slug to app data (one effect covers
	// every setActivePlayer call site) so external controllers — the playlist
	// engine's locked-focus reconciliation — can see where the TV is tuned.
	const publishedChannel = appState?.data?.currentChannel as string | undefined;
	useEffect(() => {
		const source = items.find((i) => i.id === activePlayer)?.source;
		if (!source || source === publishedChannel) return;
		desktopEventDispatch(tvSetCurrentChannel(source));
	}, [activePlayer, items, publishedChannel, desktopEventDispatch]);

	// True while the main player is buffering or not yet ready; shows the TV-static overlay.
	const [mainPlayerBuffering, setMainPlayerBuffering] = useState(true);
	// Browsers block autoplay with audio until the user interacts with the page.
	// Track first interaction so the active player stays muted until then.
	const [hasInteracted, setHasInteracted] = useState<boolean>(false);
	const [multiSelectMode, setMultiSelectMode] = useState<boolean>(
		(appState?.data?.multiSelectMode as boolean) ?? false,
	);
	const [selectedPlayers, setSelectedPlayers] = useState<number[]>([]);
	const [mutedGridPlayers, setMutedGridPlayers] = useState<number[]>([]);
	// Per-player volume (0..1) keyed by item id. Restored from channelVolumes
	// (slug-keyed) once items arrive; see the restore effect below.
	const [gridPlayerVolumes, setGridPlayerVolumes] = useState<
		Record<number, number>
	>({});
	// Live universal volume ceiling driving every player. Seeded from the persisted
	// value and updated on each slider tick for immediate audio response, but only
	// written back to the store on slider release (see the slider's onCommitFunc).
	// Re-synced whenever the persisted value changes externally — e.g. a remote
	// tvSetVolumeLimit command, or our own commit landing in app data.
	const [volumeLimit, setVolumeLimit] = useState(persistedVolumeLimit);
	useEffect(() => {
		setVolumeLimit(persistedVolumeLimit);
	}, [persistedVolumeLimit]);

	// Round the current virtual clock to the nearest 30-second boundary.
	// Thumbnails are pre-generated for every 30-second slot, keyed by Unix epoch seconds.
	const thumbTs = Math.floor(new Date(dateTime).getTime() / 1000 / 30) * 30;

	// Underlying video elements per item — QuickTimeVideoEmbed's onMediaElement
	// hands back the native <video> element, so we set currentTime directly for seeking.
	const videoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());
	// The <hls-video> element classicy renders exposes the hls.js instance as
	// `.api` (absent on Safari's native-HLS path).
	type HlsVideoEl = HTMLVideoElement & { api?: HlsAbrApi };
	const prevDateTimeRef = useRef(dateTime);
	// Stable ref to the latest UTC dateTime string for use in config callbacks.
	const dateTimeRef = useRef(dateTime);
	dateTimeRef.current = dateTime;
	// Stable ref to clockPaused so the health-check interval sees the latest value.
	const clockPausedRef = useRef(clockPaused);
	clockPausedRef.current = clockPaused;
	// Same for the TV-local pause set by the remote (separate from the clock).
	const tvPausedRef = useRef(tvPaused);
	tvPausedRef.current = tvPaused;
	// Stable ref to items so the seek effect never captures a stale closure.
	const itemsRef = useRef(items);
	itemsRef.current = items;
	// Latest per-player volumes mirrored to a ref so persistence can read fresh
	// values without making volume changes a persist trigger — a drag updates
	// the ref every tick but only commits to the store on release.
	const gridPlayerVolumesRef = useRef(gridPlayerVolumes);
	gridPlayerVolumesRef.current = gridPlayerVolumes;

	// Track the real-clock instant when dateTime last changed so the health
	// check can compute an accurate sub-minute Classicy time between updates.
	const dateTimeUpdatedAtRef = useRef<number>(Date.now());

	// Per-item hls config, built once and kept by a stable reference so the player
	// never remounts. `startLevel` is the player's tier at first sight — a sensible
	// initial quality — but tier *changes* are handled by adjusting the ABR ceiling
	// (capHlsLevel), so the picture glides between levels instead of reloading.
	const hlsConfigsRef = useRef<Map<number, object>>(new Map());
	const hlsConfigFor = (item: MediaItem, level: number): object | undefined => {
		if (!item.url.endsWith("m3u8")) return undefined;
		let config = hlsConfigsRef.current.get(item.id);
		if (!config) {
			// dateTimeRef only updates on minute boundaries, so it can be up to a
			// minute stale by the time a channel is first opened — e.g. right after
			// page load, before this channel is ever viewed. Without compensating
			// for that here, hls.js buffers starting from the stale position, then
			// onReady's seekToCurrentTime immediately yanks it forward to the real
			// position — a large, disruptive re-seek that briefly shows a corrupted
			// frame instead of video.
			const nowMs = resolveVirtualNowMs(
				dateTimeRef.current,
				dateTimeUpdatedAtRef.current,
				Date.now(),
			);
			config = {
				hls: {
					...TV_ABR_CONFIG,
					startLevel: level,
					startPosition: calcSeekSeconds(item, nowMs),
				},
			};
			hlsConfigsRef.current.set(item.id, config);
		}
		return config;
	};

	const prevActivePlayerRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		const prev = prevActivePlayerRef.current;
		prevActivePlayerRef.current = activePlayer;
		if (prev === undefined || prev === activePlayer) return;
		const fromSource =
			items.find((i) => i.id === prev)?.source ?? "unknown";
		const toSource =
			items.find((i) => i.id === activePlayer)?.source ?? "unknown";
		trackChannelChange(fromSource, toSource);
	}, [activePlayer, items]);

	// Select the first item once items arrive, and re-home the active player if its
	// channel was disabled in Settings (its item drops out of the filtered list).
	useEffect(() => {
		if (items.length === 0) return;
		if (!items.some((i) => i.id === activePlayer)) {
			setActivePlayer(items[0].id);
		}
	}, [items, activePlayer]);

	// One-shot restore of the persisted selection. Persistence stores channel
	// identity as `source` slugs (ids rotate on program rollover / fresh stream),
	// so we resolve slugs → current item ids the first time items arrive. Guarded
	// by restoredRef so it runs exactly once and never clobbers later user edits.
	const restoredRef = useRef(false);
	useEffect(() => {
		if (restoredRef.current || items.length === 0) return;
		restoredRef.current = true;
		const data = appState?.data ?? {};
		const slugToId = (slug: string) =>
			items.find((i) => i.source === slug)?.id;

		const currentChannel = data.currentChannel as string | undefined;
		if (currentChannel) {
			const id = slugToId(currentChannel);
			if (id !== undefined) setActivePlayer(id);
		}

		const selectedChannels = (data.selectedChannels as string[] | undefined) ?? [];
		const restoredSelected = selectedChannels
			.map(slugToId)
			.filter((id): id is number => id !== undefined);
		if (restoredSelected.length > 0) setSelectedPlayers(restoredSelected);

		const mutedChannels = (data.mutedChannels as string[] | undefined) ?? [];
		const restoredMuted = mutedChannels
			.map(slugToId)
			.filter((id): id is number => id !== undefined);
		if (restoredMuted.length > 0) setMutedGridPlayers(restoredMuted);

		const channelVolumes =
			(data.channelVolumes as Record<string, number> | undefined) ?? {};
		const restoredVolumes: Record<number, number> = {};
		for (const [slug, vol] of Object.entries(channelVolumes)) {
			const id = slugToId(slug);
			if (id !== undefined) restoredVolumes[id] = vol;
		}
		if (Object.keys(restoredVolumes).length > 0)
			setGridPlayerVolumes(restoredVolumes);
	}, [items, appState]);

	// Show the loading overlay whenever we switch channels.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on channel change
	useEffect(() => {
		setMainPlayerBuffering(true);
	}, [activePlayer]);

	// Record the real-clock instant each time the Classicy dateTime is updated.
	// dateTime is an intentional trigger dep; Date.now() is what we capture.
	// biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
	useEffect(() => {
		dateTimeUpdatedAtRef.current = Date.now();
	}, [dateTime]);

	// Periodic health check: ensure every player is playing and in sync.
	// Runs every 15 s. Uses real elapsed time to compute accurate Classicy
	// time between the minute-boundary Zustand updates.
	useEffect(() => {
		const healthId = setInterval(() => {
			const nowMs = resolveVirtualNowMs(
				dateTimeRef.current,
				dateTimeUpdatedAtRef.current,
				Date.now(),
			);

			for (const item of itemsRef.current) {
				const el = videoRefs.current.get(item.id);
				if (!el) continue;

				// Resume if stalled or paused (skip when the clock or the TV is paused)
				if (!clockPausedRef.current && !tvPausedRef.current && (el.paused || el.ended)) {
					el.play().catch(() => {});
				}

				// Re-seek if drift exceeds 30 seconds
				const expected = calcSeekSeconds(item, nowMs);
				if (Math.abs(el.currentTime - expected) > 30) {
					el.currentTime = expected;
				}

				// Quality watchdog: a player parked below its tier ceiling despite a
				// healthy buffer is usually stuck on a stale low bandwidth estimate —
				// probe one fragment upward so ABR gets an honest sample (maybeProbeUp).
				if (!clockPausedRef.current && !tvPausedRef.current) {
					maybeProbeUp(
						el,
						(el as HlsVideoEl).api,
						levelForItemRef.current(item),
					);
				}
			}
		}, 15_000);

		return () => clearInterval(healthId);
	}, []);

	// Seek all mounted players whenever the stored dateTime changes.
	// Natural 60-second minute-boundary ticks are skipped because the players
	// are already advancing on their own; only genuine jumps need a seek.
	useEffect(() => {
		const prevMs = new Date(prevDateTimeRef.current).getTime();
		const nowMs = new Date(dateTime).getTime();
		const delta = nowMs - prevMs;
		const isNaturalMinuteTick = delta > 0 && Math.abs(delta - 60_000) < 3_000;

		if (!isNaturalMinuteTick && prevMs !== nowMs) {
			for (const item of itemsRef.current) {
				const el = videoRefs.current.get(item.id);
				if (el) {
					el.currentTime = calcSeekSeconds(item, nowMs);
				}
			}
		}

		prevDateTimeRef.current = dateTime;
	}, [dateTime]);

	// Pause or resume all players when the system clock is paused/resumed.
	// On pause: seek every player to the exact clock position so the freeze
	// frame matches the displayed time. Resume is handled by playing={!clockPaused}.
	// biome-ignore lint/correctness/useExhaustiveDependencies: itemsRef/dateTimeRef/videoRefs are stable refs
	useEffect(() => {
		if (!clockPaused) return;
		// dateTimeRef only updates on minute boundaries, so without compensating
		// for real time elapsed since the last one, the freeze frame can land up
		// to a minute behind the time actually shown on the menu bar clock.
		const nowMs = resolveVirtualNowMs(
			dateTimeRef.current,
			dateTimeUpdatedAtRef.current,
			Date.now(),
		);
		for (const item of itemsRef.current) {
			const el = videoRefs.current.get(item.id);
			if (!el) continue;
			el.currentTime = calcSeekSeconds(item, nowMs);
		}
	}, [clockPaused]);

	// When the TV-local pause is released, jump every player forward to the live
	// clock instant — resume "catches up" to now rather than continuing from the
	// frozen frame. Pausing itself needs no seek (the frame is already correct).
	// biome-ignore lint/correctness/useExhaustiveDependencies: itemsRef/dateTimeRef/videoRefs are stable refs
	useEffect(() => {
		if (tvPaused) return;
		const nowMs = resolveVirtualNowMs(
			dateTimeRef.current,
			dateTimeUpdatedAtRef.current,
			Date.now(),
		);
		for (const item of itemsRef.current) {
			const el = videoRefs.current.get(item.id);
			if (el) el.currentTime = calcSeekSeconds(item, nowMs);
		}
	}, [tvPaused]);

	// Apply each remote view command (tune / grid / exitGrid) exactly once,
	// tracked by its monotonic seq. If the referenced channel isn't in the stream
	// yet, the seq is left unconsumed so the effect retries when `items` updates —
	// this lets a command issued before the stream loaded still land.
	const lastCommandSeqRef = useRef(0);
	useEffect(() => {
		if (!command || command.seq <= lastCommandSeqRef.current) return;

		if (command.kind === "exitGrid") {
			lastCommandSeqRef.current = command.seq;
			setMultiSelectMode(false);
			return;
		}

		if (command.kind === "tune" && command.channel !== undefined) {
			const id = resolveChannelId(command.channel, items);
			if (id === undefined) return; // not in stream yet — retry on next update
			lastCommandSeqRef.current = command.seq;
			setMultiSelectMode(false);
			setActivePlayer(id);
			setHasInteracted(true);
		} else if (command.kind === "grid" && command.channels) {
			const ids = command.channels
				.map((c) => resolveChannelId(c, items))
				.filter((x): x is number => x !== undefined);
			if (ids.length === 0) return; // none resolved yet — retry
			lastCommandSeqRef.current = command.seq;
			setMultiSelectMode(true);
			setSelectedPlayers(ids);
			setMutedGridPlayers([]);
			setHasInteracted(true);
		} else {
			lastCommandSeqRef.current = command.seq;
			return;
		}

		// Bring the TV's main window forward so the tuned channel is visible.
		desktopEventDispatch({
			type: "ClassicyWindowFocus",
			app: { id: appId },
			window: { id: `${appId}_main` },
		});
	}, [command, items, desktopEventDispatch]);

	// Persist grid layout, mute state, and the current per-player volumes. Volumes
	// are read from the ref rather than closed over, so this callback's identity
	// only changes when layout/mute change — a volume drag does not re-fire the
	// effect below. The final dragged value is committed explicitly on release.
	const persistGridState = useCallback(() => {
		const idToSlug = (id: number) =>
			itemsRef.current.find((i) => i.id === id)?.source;
		const selectedChannels = selectedPlayers
			.map(idToSlug)
			.filter((s): s is string => !!s);
		const mutedChannels = mutedGridPlayers
			.map(idToSlug)
			.filter((s): s is string => !!s);
		const channelVolumes: Record<string, number> = {};
		for (const [id, vol] of Object.entries(gridPlayerVolumesRef.current)) {
			const slug = idToSlug(Number(id));
			if (slug) channelVolumes[slug] = vol;
		}
		desktopEventDispatch({
			type: "ClassicyAppTVSetGridState",
			multiSelectMode,
			selectedChannels,
			mutedChannels,
			channelVolumes,
		});
	}, [multiSelectMode, selectedPlayers, mutedGridPlayers, desktopEventDispatch]);

	// Persist on mount and whenever layout/mute change (volumes ride along from
	// the ref). Per-player volume drags persist via persistGridState on release.
	// Skip the very first run: on mount the selection is empty/not-yet-restored,
	// and persisting it would overwrite the stored slugs the restore effect reads.
	// The restore effect's setState re-fires this via persistGridState's identity.
	const persistedOnceRef = useRef(false);
	useEffect(() => {
		if (!persistedOnceRef.current) {
			persistedOnceRef.current = true;
			return;
		}
		persistGridState();
	}, [persistGridState]);

	const persistCaptionState = useCallback(() => {
		desktopEventDispatch(tvSetCaptionState(captionsOn, captionStyle));
	}, [captionsOn, captionStyle, desktopEventDispatch]);

	useEffect(() => {
		persistCaptionState();
	}, [persistCaptionState]);

	useEffect(() => {
		desktopEventDispatch(tvSetActivePlayer(activePlayer));
	}, [activePlayer, desktopEventDispatch]);

	const toggleMultiSelect = () => {
		setMultiSelectMode((prev) => {
			const entering = !prev;
			setSelectedPlayers(entering && activePlayer ? [activePlayer] : []);
			setMutedGridPlayers([]);
			return entering;
		});
	};

	const togglePlayerSelection = (id: number) => {
		setSelectedPlayers((prev) =>
			prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
		);
	};

	const toggleGridPlayerMute = (id: number) => {
		setHasInteracted(true);
		setMutedGridPlayers((prev) =>
			prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
		);
	};

	const setGridPlayerVolume = (id: number, volume: number) => {
		setHasInteracted(true);
		setGridPlayerVolumes((prev) => ({ ...prev, [id]: volume }));
	};

	const gridColumns = Math.ceil(Math.sqrt(Math.max(1, selectedPlayers.length)));

	/** Seek the given item's video element to the current clock position. */
	const seekToCurrentTime = (item: MediaItem) => {
		const el = videoRefs.current.get(item.id);
		if (!el) return;
		const nowMs = resolveVirtualNowMs(
			dateTimeRef.current,
			dateTimeUpdatedAtRef.current,
			Date.now(),
		);
		el.currentTime = calcSeekSeconds(item, nowMs);
	};

	// Cap an hls.js player's quality at its tier *ceiling*, leaving ABR enabled so
	// it gracefully ramps up to the cap and degrades below it as bandwidth allows —
	// never a forced, buffer-flushing switch. QuickTimeVideoEmbed renders
	// hls-video-element, which exposes the hls.js instance as `.api`; `autoLevelCapping` is the max
	// level the ABR controller may pick (ABR stays auto, currentLevel untouched).
	// Setting it just steers future fragment selection, so up/down moves smoothly
	// at segment boundaries. Idempotent guard avoids redundant ABR re-evaluations.
	const capHlsLevel = useCallback((id: number, level: number) => {
		const el = videoRefs.current.get(id) as HlsVideoEl | undefined;
		if (el?.api && el.api.autoLevelCapping !== level) el.api.autoLevelCapping = level;
	}, []);

	// One-time aggressive bump when a channel gains single-view focus: reset
	// the bandwidth estimate optimistically and force an immediate switch to
	// the tier ceiling (flushing buffered low-res), then let ABR resume — see
	// bumpToLevel. Complements capHlsLevel, which only sets the ceiling.
	const bumpHlsLevel = useCallback((id: number, level: number) => {
		const el = videoRefs.current.get(id) as HlsVideoEl | undefined;
		if (el?.api) bumpToLevel(el.api, level);
	}, []);

	// The quality ceiling for a player: the single focused video (the active channel,
	// or a grid of one) is capped at HIGHEST; a multi-video grid at ONE_DOWN; every
	// other thumbnail at LOWEST. Single source of truth for the config startLevel,
	// the onReady cap, and the re-cap effect below.
	const levelForItem = useCallback(
		(item: MediaItem): number => {
			if (multiSelectMode) {
				if (!selectedPlayers.includes(item.id)) return QUALITY_LOWEST;
				return selectedPlayers.length <= 1 ? QUALITY_HIGHEST : QUALITY_ONE_DOWN;
			}
			return item.id === activePlayer ? QUALITY_HIGHEST : QUALITY_LOWEST;
		},
		[multiSelectMode, selectedPlayers, activePlayer],
	);

	// Stable ref to levelForItem so the health-check interval (empty deps) sees
	// the current tiering without re-registering the timer.
	const levelForItemRef = useRef(levelForItem);
	levelForItemRef.current = levelForItem;

	// Re-cap every loaded player whenever the tiering inputs change (active channel,
	// selection set, grid mode); ABR then glides toward the new ceiling. onReady
	// covers the initial cap for players that load after this runs. A player whose
	// tier RISES to HIGHEST without remounting (grid shrinking to one) additionally
	// gets the aggressive bump — remounting players get theirs from onReady.
	const prevLevelsRef = useRef<Map<number, number>>(new Map());
	useEffect(() => {
		const prev = prevLevelsRef.current;
		const next = new Map<number, number>();
		for (const item of items) {
			const level = levelForItem(item);
			next.set(item.id, level);
			capHlsLevel(item.id, level);
			const before = prev.get(item.id);
			if (
				level === QUALITY_HIGHEST &&
				before !== undefined &&
				before < QUALITY_HIGHEST
			) {
				bumpHlsLevel(item.id, level);
			}
		}
		prevLevelsRef.current = next;
	}, [items, levelForItem, capHlsLevel, bumpHlsLevel]);

	// Re-sync the working copy from persisted state, reveal the window, and focus
	// it so the modal is keyboard-ready the instant it opens (mirrors Browser).
	const openSettings = useCallback(() => {
		setChannelForm(disabledChannels);
		setShowSettings(true);
		desktopEventDispatch({
			type: "ClassicyWindowFocus",
			app: { id: appId },
			window: { id: `${appId}_settings` },
		});
	}, [disabledChannels, desktopEventDispatch]);

	const saveSettings = useCallback(() => {
		desktopEventDispatch({
			type: "ClassicyAppTVSetDisabledChannels",
			disabledChannels: channelForm,
		});
		setShowSettings(false);
	}, [channelForm, desktopEventDispatch]);

	// A checked box means the channel is ON, so toggling drops it from / adds it
	// to the disabled list.
	const toggleChannel = useCallback((channel: string, enabled: boolean) => {
		setChannelForm((prev) =>
			enabled ? prev.filter((c) => c !== channel) : [...prev, channel],
		);
	}, []);

	// Step the tuned channel by `delta` places through the visible channel list,
	// wrapping at both ends (+1 = ▲/next, -1 = ▼/previous). Adding items.length
	// before the modulo keeps a negative step in range. Shared by the ▲/▼ buttons.
	const changeChannel = useCallback(
		(delta: number) => {
			if (orderedItems.length === 0) return;
			const idx = orderedItems.findIndex((i) => i.id === activePlayer);
			const next = (idx + delta + orderedItems.length) % orderedItems.length;
			setActivePlayer(orderedItems[next].id);
			setHasInteracted(true);
		},
		[orderedItems, activePlayer],
	);

	const appMenu = [
		{
			id: "file",
			title: "File",
			menuChildren: [
				{
					id: `${appId}_settings`,
					title: "Settings…",
					onClickFunc: openSettings,
				},
				quitMenuItemHelper(appId, appName, appIcon),
			],
		},
		{
			id: "view",
			title: "View",
			menuChildren: [
				{
					id: `${appId}_show_epg`,
					title: "Show EPG",
					onClickFunc: () => setShowEpg(true),
				},
				{
					id: `${appId}_channel_up`,
					title: "Channel ▲",
					onClickFunc: () => changeChannel(1),
				},
				{
					id: `${appId}_channel_down`,
					title: "Channel ▼",
					onClickFunc: () => changeChannel(-1),
				},
				quitMenuItemHelper(appId, appName, appIcon),
			],
		},
		{
			id: "controls",
			title: "Controls",
			menuChildren: [
				{
					id: `${appId}_mute_all`,
					title: `${volumeLimit == 0 ? "✓ " : "  "} Mute${volumeLimit ==0 ? "d" : ""}`,
					onClickFunc: () => volumeLimit == 0 ? setVolumeLimit(100) : setVolumeLimit(0),
				},
				{
					id: `${appId}_pause_all`,
					title: `${tvPaused ? "✓ " : "  "} Pause${tvPaused ? "d" : ""}`,
					onClickFunc: () => desktopEventDispatch(tvPaused ? tvResume() : tvPause())
				},
			],
		},
	];

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={`${appId}_main`}
		>
			{showSettings && (
				<ClassicyWindow
					id={`${appId}_settings`}
					title={"Settings"}
					appId={appId}
					icon={appIcon}
					closable={true}
					resizable={false}
					zoomable={false}
					scrollable={true}
					collapsable={false}
					initialSize={[400, 0]}
					initialPosition={[150, 120]}
					modal={true}
					appMenu={appMenu}
					onCloseFunc={() => setShowSettings(false)}
				>
					<div className={styles.tvSettings}>
						<ClassicyTabs tabs={[
							{
								title: "Channels",
								children: (
									<div className={styles.tvSettingsChannels}>
										{availableChannels.length === 0 ? (
											<ClassicyControlLabel label="No channels available." />
										) : (
											availableChannels.map((channel) => (
												<ClassicyCheckbox
													key={channel}
													id={`tv_channel_${channel}`}
													label={channel}
													checked={!channelForm.includes(channel)}
													onClickFunc={(checked: boolean) =>
														toggleChannel(channel, checked)
													}
												/>
											))
										)}
									</div>
								),
							},
							{
								title: "Captions",
								children: (
									<>
										<ClassicyControlLabel label="Font" />
										<div className={styles.captionFontRow}>
											{FONT_VARS.map(([varName, label]) => (
												<ClassicyButton
													key={varName}
													depressed={captionStyle.font === varName}
													buttonSize="small"
													margin="sm"
													padding="sm"
													onClickFunc={() => setCaptionStyle((s) => ({ ...s, font: varName }))}
												>
													{label}
												</ClassicyButton>
											))}
										</div>
										<ClassicyColorPicker
											id="cc_text_color"
											labelTitle="Text Color"
											value={captionStyle.color}
											crayons={MAC_OS_8_CRAYONS}
											onChangeFunc={(color) => setCaptionStyle((s) => ({ ...s, color }))}
										/>
										<ClassicySlider
											id="cc_text_opacity"
											labelTitle="Text Opacity"
											ariaLabel="Caption text opacity"
											value={captionStyle.colorOpacity}
											min={0}
											max={1}
											step={0.05}
											labelSize="small"
											valueLabel={`${Math.round(captionStyle.colorOpacity * 100)}%`}
											onChangeFunc={(e: React.ChangeEvent<HTMLInputElement>) =>
												setCaptionStyle((s) => ({ ...s, colorOpacity: parseFloat(e.target.value) }))
											}
										/>
										<ClassicyColorPicker
											id="cc_bg_color"
											labelTitle="Background Color"
											value={captionStyle.bgColor}
											crayons={MAC_OS_8_CRAYONS}
											onChangeFunc={(color) => setCaptionStyle((s) => ({ ...s, bgColor: color }))}
										/>
										<ClassicySlider
											id="cc_bg_opacity"
											labelTitle="Background Opacity"
											ariaLabel="Caption background opacity"
											value={captionStyle.bgOpacity}
											min={0}
											max={1}
											step={0.05}
											labelSize="small"
											valueLabel={`${Math.round(captionStyle.bgOpacity * 100)}%`}
											onChangeFunc={(e: React.ChangeEvent<HTMLInputElement>) =>
												setCaptionStyle((s) => ({ ...s, bgOpacity: parseFloat(e.target.value) }))
											}
										/>
										<ClassicySlider
											id="cc_size"
											labelTitle="Size"
											ariaLabel="Caption font size"
											value={captionStyle.size}
											min={50}
											max={200}
											step={10}
											labelSize="small"
											valueLabel={`${captionStyle.size}%`}
											onChangeFunc={(e: React.ChangeEvent<HTMLInputElement>) =>
												setCaptionStyle((s) => ({ ...s, size: parseFloat(e.target.value) }))
											}
										/>
									</>
								),
							},
						]} />
						<div className={styles.tvSettingsButtons}>
							<ClassicyButton onClickFunc={() => setShowSettings(false)}>
								Cancel
							</ClassicyButton>
							<ClassicyButton isDefault={true} onClickFunc={saveSettings}>
								Save
							</ClassicyButton>
						</div>
					</div>
				</ClassicyWindow>
			)}
			<ClassicyWindow
				id={`${appId}_main`}
				title={appName}
				appId={appId}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				scrollable={false}
				collapsable={true}
				initialSize={["75%", "75%"]}
				initialPosition={["left", "top"]}
				minimumSize={[600, 300]}
				modal={false}
				appMenu={appMenu}
				dimContents={false}
			>
				<div className={styles.tvContainer}>
					<div className={styles.tvMainArea}>
						{showEpg && (
							<TVEPGPanel onClose={() => setShowEpg(false)} />
						)}
						{!multiSelectMode && (() => {
							const item = items.find((i) => i.id === activePlayer);
							if (!item) return null;
							return (
								<>
									<img
										src={`${import.meta.env.BASE_URL}img/loading.webp`}
										className={`${styles.tvLoadingOverlay}${mainPlayerBuffering ? ` ${styles.tvLoadingOverlayVisible}` : ""}`}
										alt=""
									/>
									{/* Keyed by channel: onMediaElement only fires on mount/unmount, so a
									    channel switch must remount the embed to re-register videoRefs. */}
									<QuickTimeVideoEmbed
										key={item.id}
										appId={appId}
										name={item.source ?? String(item.id)}
										url={item.url}
										type="video"
										hideControls
										onMediaElement={(el) => {
											if (el) videoRefs.current.set(item.id, el);
											else videoRefs.current.delete(item.id);
										}}
										onReady={() => {
											setMainPlayerBuffering(false);
											seekToCurrentTime(item);
											const level = levelForItem(item);
											capHlsLevel(item.id, level);
											if (level === QUALITY_HIGHEST) bumpHlsLevel(item.id, level);
										}}
										onWaiting={() => setMainPlayerBuffering(true)}
										onPlaying={() => setMainPlayerBuffering(false)}
										playing={!clockPaused && !tvPaused}
										muted={overallMuted || !hasInteracted}
										volume={volumeLimit}
										captionsEnabled={captionsOn}
										captionStyle={captionStyle}
										subtitlesUrl={vttUrl(item.subtitles)}
										options={hlsConfigFor(item, levelForItem(item))}
										crossOrigin="anonymous"
										playsInline
									/>
								</>
							);
						})()}
						{multiSelectMode && selectedPlayers.length > 0 && (
							<div
								className={styles.tvMainGrid}
								style={{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }}
							>
								{selectedPlayers.map((id) => {
									const item = items.find((i) => i.id === id);
									if (!item) return null;
									const isGridMuted =
										overallMuted || !hasInteracted || mutedGridPlayers.includes(id);
									return (
										<div key={id} className={styles.tvGridPlayer}>
											<div className={styles.tvChannelTitleHolder}>
												<p className={styles.tvChannelTitle}>{item.source}</p>
											</div>
											<div className={styles.tvGridPlayerControls}>
												<button
													className={styles.tvGridPlayerControlBtn}
													type="button"
													onMouseUp={() => toggleGridPlayerMute(id)}
												>
													<img
														src={isGridMuted
															? ClassicyIcons.controlPanels.soundManager.soundMute as string
															: ClassicyIcons.controlPanels.soundManager.soundOn as string}
														alt={isGridMuted ? "Unmute" : "Mute"}
													/>
												</button>
												<button
													className={styles.tvGridPlayerControlBtn}
													type="button"
													onMouseUp={() => togglePlayerSelection(id)}
												>
													✕
												</button>
											</div>
											<div className={styles.tvGridPlayerVolume}>
												<ClassicySlider
													id={`tv_grid_volume_${id}`}
													ariaLabel={`Volume for ${item.source}`}
													value={gridPlayerVolumes[id] ?? 1}
													min={0}
													max={1}
													step={0.05}
													labelSize="small"
													valueLabel={`${Math.round(
														(gridPlayerVolumes[id] ?? 1) * 100,
													)}%`}
													onChangeFunc={(
														e: React.ChangeEvent<HTMLInputElement>,
													) =>
														setGridPlayerVolume(
															id,
															parseFloat(e.target.value),
														)
													}
													onCommitFunc={persistGridState}
												/>
											</div>
											<QuickTimeVideoEmbed
												appId={appId}
												name={item.source ?? String(id)}
												url={item.url}
												type="video"
												hideControls
												onMediaElement={(el) => {
													if (el) videoRefs.current.set(id, el);
													else videoRefs.current.delete(id);
												}}
												onReady={() => {
													seekToCurrentTime(item);
													const level = levelForItem(item);
													capHlsLevel(id, level);
													if (level === QUALITY_HIGHEST) bumpHlsLevel(id, level);
												}}
												playing={!clockPaused && !tvPaused}
												muted={isGridMuted}
												volume={resolveGridVolume(
													gridPlayerVolumes[id],
													volumeLimit,
													isGridMuted,
												)}
												captionsEnabled={captionsOn}
												captionStyle={captionStyle}
												subtitlesUrl={vttUrl(item.subtitles)}
												options={hlsConfigFor(item, levelForItem(item))}
												crossOrigin="anonymous"
												playsInline
											/>
										</div>
									);
								})}
							</div>
						)}
					</div>
					<div className={styles.tvBottomRow}>
						<div className={styles.tvControlPanel}>
							<div className={styles.tvControlButtons}>
								<ClassicyButton onClickFunc={toggleMultiSelect} depressed={multiSelectMode} buttonSize="small" margin="sm" padding="sm">
									MultiView
								</ClassicyButton>
								<ClassicyButton
									onClickFunc={() =>
										desktopEventDispatch(tvPaused ? tvResume() : tvPause())
									}
									depressed={tvPaused}
									buttonSize="small"
									margin="sm" padding="sm"
								>
									{tvPaused ? "Play" : "Pause"}
								</ClassicyButton>
								<ClassicyButton
									onClickFunc={() => {
										setHasInteracted(true);
										desktopEventDispatch(tvSetMuted(!overallMuted));
									}}
									depressed={overallMuted}
									buttonSize="small"
									margin="sm" padding="sm"
								>
									Mute
								</ClassicyButton>
								<ClassicyButton
									onClickFunc={() => setCaptionsOn((v) => !v)}
									depressed={captionsOn}
									buttonSize="small"
									margin="sm" padding="sm"
								>
									{captionsOn ? "CC On" : "CC Off"}
								</ClassicyButton>
							</div>
							<ClassicySlider
								id="tv_universal_volume"
								labelTitle="Volume"
								labelPosition="left"
								labelSize="small"
								value={volumeLimit}
								min={0}
								max={1}
								step={0.05}
								valueLabel={`${Math.round(volumeLimit * 100)}%`}
								onChangeFunc={(e: React.ChangeEvent<HTMLInputElement>) =>
									setVolumeLimit(parseFloat(e.target.value))
								}
								onCommitFunc={(v) =>
									desktopEventDispatch(tvSetVolumeLimit(v))
								}
							/>
							<div className={styles.tvChannelButtons}>
								{!multiSelectMode && (
									<>
										<ClassicyButton
											onClickFunc={() => changeChannel(1)}
											buttonSize="small"
											margin="sm"
											padding="sm"
										>
											▲
										</ClassicyButton>
										<ClassicyButton
											onClickFunc={() => changeChannel(-1)}
											buttonSize="small"
											margin="sm"
											padding="sm"
										>
											▼
										</ClassicyButton>
									</>
								)}
								<ClassicyButton
									onClickFunc={() => setShowEpg((v) => !v)}
									depressed={showEpg}
									buttonSize="small"
									margin="sm"
									padding="sm"
								>
									EPG
								</ClassicyButton>
							</div>
						</div>
						<div className={styles.tvThumbnailStrip}>
							{orderedItems.map((item) => {
								// In multi-select mode no thumbnail is "active" (no absolute overlay)
								const isActive = !multiSelectMode && item.id === activePlayer;
								const isSelected = selectedPlayers.includes(item.id);

								return (
									<button
										key={item.id}
										data-source={item.source}
										className={[
											styles.tvPlayer,
											isActive || isSelected ? styles.tvPlayerSelected : "",
											reorder.dragSource === item.source ? styles.tvPlayerDragging : "",
											reorder.dropTarget === item.source &&
											reorder.dragSource !== item.source
												? styles.tvPlayerDropTarget
												: "",
										]
											.filter(Boolean)
											.join(" ")}
										{...(item.source ? reorder.handlers(item.source) : {})}
										onClick={() => {
											// A drag just ended — it must not focus or select.
											if (reorder.consumeSuppressedClick()) return;
											if (multiSelectMode) {
												togglePlayerSelection(item.id);
											} else {
												setActivePlayer(item.id);
											}
											setHasInteracted(true);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												if (multiSelectMode) {
													togglePlayerSelection(item.id);
												} else {
													setActivePlayer(item.id);
												}
												setHasInteracted(true);
											}
										}}
										type="button"
									>
										<div className={styles.tvChannelTitleHolder}>
											<p className={styles.tvChannelTitle}>{item.source}</p>
										</div>
										<img
											className={styles.tvThumbnailImage}
											src={`https://files.911realtime.org/thumbnails/${
												item.source?.toLowerCase() ?? "offline"
											}/${thumbTs}.jpg`}
											onError={(e) => {
												e.currentTarget.src =
													"https://files.911realtime.org/thumbnails/offline.jpg";
											}}
											alt=""
										/>
									</button>
								);
							})}
							{reorder.dragOutline && (
								<div
									className={styles.tvDragOutline}
									style={{
										left: reorder.dragOutline.x,
										top: reorder.dragOutline.y,
										width: reorder.dragOutline.width,
										height: reorder.dragOutline.height,
									}}
								/>
							)}
						</div>
					</div>
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};

