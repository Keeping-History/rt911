import {
	ClassicyApp,
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyControlGroup,
	ClassicyControlLabel,
	ClassicyIcons,
	ClassicySlider,
	ClassicyWindow,
	quitMenuItemHelper,
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactPlayer from "react-player";
import type {
	MediaItem,
	MediaStreamFilter,
} from "../../Providers/MediaStream/MediaStreamContext";
import { vttUrl } from "../../Providers/MediaStream/MediaStreamContext";
import { useMediaStream } from "../../Providers/MediaStream/useMediaStream";
import styles from "./TV.module.scss";
import {
	type TVChannelRef,
	type TVRemoteCommand,
	tvPause,
	tvResume,
	tvSetMuted,
	tvSetVolumeLimit,
} from "./TVContext";
import { resolveGridVolume } from "./volume";

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

/** Seconds into the media file that corresponds to the given wall-clock time. */
function calcSeekSeconds(item: MediaItem, clockMs: number): number {
	// Directus stores datetimes without a timezone suffix; force UTC so that
	// JavaScript does not misinterpret them as local time.
	const dateStr = /Z$|[+-]\d{2}:\d{2}$/.test(item.start_date)
		? item.start_date
		: item.start_date + "Z";
	const startMs = new Date(dateStr).getTime();
	const raw = (clockMs - startMs) / 1000 + item.jump;
	// Do not cap by calc_duration — it may be inaccurate for archive streams.
	// Let the player handle out-of-bounds positions natively.
	return Math.max(0, raw);
}

type ClassicyTVProps = Record<string, never>;

export const TV: React.FC<ClassicyTVProps> = () => {
	const appName = "TV";
	const appId = "TV.app";
	const appIcon = ClassicyIcons.applications.epg.app as string;

	const desktopEventDispatch = useAppManagerDispatch();
	const appState = useAppManager(
		(state) => state.System.Manager.Applications.apps[appId],
	);

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

	const [captionsOn, setCaptionsOn] = useState<boolean>(false);
	const [showSettings, setShowSettings] = useState<boolean>(false);
	// Settings form: local working copy of the disabled set, committed on Save.
	const [channelForm, setChannelForm] = useState<string[]>(disabledChannels);
	const [activePlayer, setActivePlayer] = useState<number>(0);
	// Browsers block autoplay with audio until the user interacts with the page.
	// Track first interaction so the active player stays muted until then.
	const [hasInteracted, setHasInteracted] = useState<boolean>(false);
	const [multiSelectMode, setMultiSelectMode] = useState<boolean>(
		(appState?.data?.multiSelectMode as boolean) ?? false,
	);
	const [selectedPlayers, setSelectedPlayers] = useState<number[]>(
		(appState?.data?.selectedPlayers as number[]) ?? [],
	);
	const [mutedGridPlayers, setMutedGridPlayers] = useState<number[]>(
		(appState?.data?.mutedGridPlayers as number[]) ?? [],
	);
	// Per-player volume (0..1) keyed by item id. A missing entry plays at full
	// (1.0), still capped by the universal volumeLimit. Persisted alongside the
	// mute set through ClassicyAppTVSetGridState — but only on slider release,
	// not on every drag tick (see persistGridState).
	const [gridPlayerVolumes, setGridPlayerVolumes] = useState<
		Record<number, number>
	>((appState?.data?.gridPlayerVolumes as Record<number, number>) ?? {});
	// Live universal volume ceiling driving every player. Seeded from the persisted
	// value and updated on each slider tick for immediate audio response, but only
	// written back to the store on slider release (see the slider's onCommitFunc).
	// Re-synced whenever the persisted value changes externally — e.g. a remote
	// tvSetVolumeLimit command, or our own commit landing in app data.
	const [volumeLimit, setVolumeLimit] = useState(persistedVolumeLimit);
	useEffect(() => {
		setVolumeLimit(persistedVolumeLimit);
	}, [persistedVolumeLimit]);

	// Underlying video elements per item — react-player 3.x forwards refs to
	// the native <video> element, so we set currentTime directly for seeking.
	const videoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());
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
			const nowMs = new Date(dateTimeRef.current).getTime();
			config = { hls: { startLevel: level, startPosition: calcSeekSeconds(item, nowMs) } };
			hlsConfigsRef.current.set(item.id, config);
		}
		return config;
	};

	// Select the first item once items arrive, and re-home the active player if its
	// channel was disabled in Settings (its item drops out of the filtered list).
	useEffect(() => {
		if (items.length === 0) return;
		if (!items.some((i) => i.id === activePlayer)) {
			setActivePlayer(items[0].id);
		}
	}, [items, activePlayer]);

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
			const elapsedRealMs = Date.now() - dateTimeUpdatedAtRef.current;
			const nowMs = new Date(dateTimeRef.current).getTime() + elapsedRealMs;

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
		const nowMs = new Date(dateTimeRef.current).getTime();
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
		const elapsedRealMs = Date.now() - dateTimeUpdatedAtRef.current;
		const nowMs = new Date(dateTimeRef.current).getTime() + elapsedRealMs;
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
		desktopEventDispatch({
			type: "ClassicyAppTVSetGridState",
			multiSelectMode,
			selectedPlayers,
			mutedGridPlayers,
			gridPlayerVolumes: gridPlayerVolumesRef.current,
		});
	}, [multiSelectMode, selectedPlayers, mutedGridPlayers, desktopEventDispatch]);

	// Persist on mount and whenever layout/mute change (volumes ride along from
	// the ref). Per-player volume drags persist via persistGridState on release.
	useEffect(() => {
		persistGridState();
	}, [persistGridState]);

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
		const elapsedRealMs = Date.now() - dateTimeUpdatedAtRef.current;
		const nowMs = new Date(dateTimeRef.current).getTime() + elapsedRealMs;
		el.currentTime = calcSeekSeconds(item, nowMs);
	};

	// Cap an hls.js player's quality at its tier *ceiling*, leaving ABR enabled so
	// it gracefully ramps up to the cap and degrades below it as bandwidth allows —
	// never a forced, buffer-flushing switch. ReactPlayer wraps hls-video-element,
	// which exposes the hls.js instance as `.api`; `autoLevelCapping` is the max
	// level the ABR controller may pick (ABR stays auto, currentLevel untouched).
	// Setting it just steers future fragment selection, so up/down moves smoothly
	// at segment boundaries. Idempotent guard avoids redundant ABR re-evaluations.
	const capHlsLevel = useCallback((id: number, level: number) => {
		const el = videoRefs.current.get(id) as
			| (HTMLVideoElement & { api?: { autoLevelCapping: number } })
			| undefined;
		if (el?.api && el.api.autoLevelCapping !== level) el.api.autoLevelCapping = level;
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

	// Re-cap every loaded player whenever the tiering inputs change (active channel,
	// selection set, grid mode); ABR then glides toward the new ceiling. onReady
	// covers the initial cap for players that load after this runs.
	useEffect(() => {
		for (const item of items) capHlsLevel(item.id, levelForItem(item));
	}, [items, levelForItem, capHlsLevel]);

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
					closable={true}
					resizable={false}
					zoomable={false}
					scrollable={true}
					collapsable={false}
					initialSize={[300, 0]}
					initialPosition={[150, 120]}
					modal={true}
					appMenu={appMenu}
					onCloseFunc={() => setShowSettings(false)}
				>
					<div className={styles.tvSettings}>
						<ClassicyControlGroup label="Channels" columns={true}>
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
						</ClassicyControlGroup>
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
				closable={true}
				resizable={true}
				zoomable={true}
				scrollable={false}
				collapsable={true}
				initialSize={[800, 400]}
				initialPosition={[100, 50]}
				minimumSize={[600, 300]}
				modal={false}
				appMenu={appMenu}
			>
				<div className={styles.tvContainer}>
					<div className={styles.tvMainArea}>
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
											<ReactPlayer
												ref={(el: HTMLVideoElement | null) => {
													if (el) videoRefs.current.set(id, el);
													else videoRefs.current.delete(id);
												}}
												onReady={() => {
													seekToCurrentTime(item);
													capHlsLevel(id, levelForItem(item));
												}}
												src={item.url}
												playing={!clockPaused && !tvPaused}
												loop={false}
												controls={false}
												playsInline={true}
												muted={isGridMuted}
												volume={resolveGridVolume(
													gridPlayerVolumes[id],
													volumeLimit,
													isGridMuted,
												)}
												width="100%"
												height="100%"
												config={hlsConfigFor(item, levelForItem(item))}
												crossOrigin="anonymous"
											>
												{captionsOn && vttUrl(item.subtitles) && (
													<track
														kind="subtitles"
														srcLang="en"
														label="English"
														src={vttUrl(item.subtitles)}
														default
													/>
												)}
											</ReactPlayer>
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
									Grid
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
						</div>
						<div className={styles.tvThumbnailStrip}>
							{items.map((item) => {
								// In multi-select mode no thumbnail is "active" (no absolute overlay)
								const isActive = !multiSelectMode && item.id === activePlayer;
								const isSelected = selectedPlayers.includes(item.id);

								// Selected items in multi-select mode render their player in the grid
								// (which owns the videoRef for health checks); thumbnail shows title only.
								const renderThumbnailPlayer = !multiSelectMode || !isSelected;
								// The single focused (active) channel plays full quality; every
								// other thumbnail plays lowest. Grid players are sized separately.
								const itemConfig = hlsConfigFor(item, levelForItem(item));

								return (
									<button
										key={item.id}
										className={[
											styles.tvPlayer,
											isActive ? styles.tvPlayerActive : "",
											isSelected ? styles.tvPlayerSelected : "",
										]
											.filter(Boolean)
											.join(" ")}
										onClick={() => {
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
										{renderThumbnailPlayer && (
											<ReactPlayer
												ref={(el: HTMLVideoElement | null) => {
													if (el) videoRefs.current.set(item.id, el);
													else videoRefs.current.delete(item.id);
												}}
												onReady={() => {
													seekToCurrentTime(item);
													capHlsLevel(item.id, levelForItem(item));
												}}
												src={item.url}
												playing={!clockPaused && !tvPaused}
												loop={false}
												controls={false}
												playsInline={true}
												muted={overallMuted || !(isActive && hasInteracted)}
												volume={
													overallMuted || !(isActive && hasInteracted) ? 0 : volumeLimit
												}
												width="100%"
												height="100%"
												config={itemConfig}
												crossOrigin="anonymous"
											>
												{captionsOn && vttUrl(item.subtitles) && (
													<track
														kind="subtitles"
														srcLang="en"
														label="English"
														src={vttUrl(item.subtitles)}
														default
													/>
												)}
											</ReactPlayer>
										)}
									</button>
								);
							})}
						</div>
					</div>
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};
