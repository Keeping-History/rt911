import {
	ClassicyApp,
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyColorPicker,
	ClassicyIcons,
	ClassicyPopUpMenu,
	ClassicySlider,
	ClassicyWindow,
	MAC_OS_8_CRAYONS,
	quitMenuItemHelper,
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import {
	type ChangeEvent,
	type FC,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	MediaStreamContext,
	type FlightPosition,
} from "../../Providers/MediaStream/MediaStreamContext";
import { virtualUtcMs } from "../../Providers/MediaStream/virtualClock";
import { FlightDetailPanel } from "./FlightDetailPanel";
import { FlightMap } from "./FlightMap";
import { type TrackSelection, useFlightTrack } from "./useFlightTrack";
// Importing this module also registers the ClassicyAppFlightTracker reducer.
import {
	type FlightMapSettings,
	flightTrackerSetLoopSettings,
	flightTrackerSetMapSettings,
	intToHex,
	readFlightLoopSettings,
	readFlightMapSettings,
} from "./flightMapSettings";
import { insertReplaySamples, pruneReplay, type ReplayBuffer } from "./flightReplay";
import { headingFromTrack } from "./flightMotion";
import {
	formatPlayhead,
	LOOP_SPEEDS,
	type LoopClock,
	type LoopSpeed,
	type LoopWindowMinutes,
	playheadAt,
	SPEED_LABELS,
} from "./loopClock";
import styles from "./FlightTracker.module.scss";
import type { Feature } from "geojson";

const BASEMAP_URL =
	(import.meta.env.VITE_FLIGHT_BASEMAP_URL as string | undefined) ??
	"https://files.911realtime.org/maps/na-basemap.pmtiles";

export const FlightTracker: FC = () => {
	const appId = "FlightTracker.app";
	const appName = "Flight Tracker";
	const appIcon = ClassicyIcons.controlPanels.location.app as string;

	const isRunning = useAppManager(
		(s) => appId in (s.System.Manager.Applications.apps ?? {}),
	);

	const desktopEventDispatch = useAppManagerDispatch();
	const appData = useAppManager(
		(s) =>
			s.System.Manager.Applications.apps[appId]?.data as
				| Record<string, unknown>
				| undefined,
	);
	const settings = useMemo(() => readFlightMapSettings(appData), [appData]);
	const loopSettings = useMemo(() => readFlightLoopSettings(appData), [appData]);

	const [showSettings, setShowSettings] = useState(false);
	// Settings form: local working copy, committed on Save (TV pattern).
	const [form, setForm] = useState<FlightMapSettings>(settings);

	// Re-sync the working copy from persisted state, reveal, and focus.
	const openSettings = useCallback(() => {
		setForm(settings);
		setShowSettings(true);
		desktopEventDispatch({
			type: "ClassicyWindowFocus",
			app: { id: appId },
			window: { id: "flight-settings" },
		});
	}, [settings, desktopEventDispatch]);

	const saveSettings = useCallback(() => {
		desktopEventDispatch(flightTrackerSetMapSettings(form));
		setShowSettings(false);
	}, [form, desktopEventDispatch]);

	const toggleDarkMap = useCallback(() => {
		desktopEventDispatch(
			flightTrackerSetMapSettings({ ...settings, darkMap: !settings.darkMap }),
		);
	}, [settings, desktopEventDispatch]);

	const toggleRadarSweep = useCallback(() => {
		desktopEventDispatch(
			flightTrackerSetMapSettings({ ...settings, radarSweep: !settings.radarSweep }),
		);
	}, [settings, desktopEventDispatch]);

	const {
		flightPositions,
		subscribeFlights,
		unsubscribeFlights,
		connected,
		flightsHistory,
		requestFlightsHistory,
		clearFlightsHistory,
	} = useContext(MediaStreamContext);

	// Read-only: this app never mutates the clock (only TimeMachine does). The
	// animation loop needs the true-UTC instant + play state; virtualUtcMs strips
	// the display tz back off (same conversion the MediaStreamProvider uses).
	const { localDate, tzOffset, paused } = useClassicyDateTime({ tick: true });
	const nowMs = virtualUtcMs(localDate, tzOffset);

	// Subscribe only while the app is open (ref-counted by appId server-side).
	useEffect(() => {
		if (!isRunning) return;
		subscribeFlights(appId);
		return () => unsubscribeFlights(appId);
	}, [isRunning, subscribeFlights, unsubscribeFlights, appId]);

	const [selected, setSelected] = useState<FlightPosition | null>(null);

	// Loop mode: the enable flag, window, and speed are persisted preferences
	// (readFlightLoopSettings), so they survive a refresh. Only the ephemeral
	// playback state below (clock anchors, scrubbing, paused) stays local — the
	// Classicy clock keeps running live and is never written from here.
	const loopEnabled = loopSettings.enabled;
	const loopMinutes = loopSettings.windowMinutes;
	// Anchored at the top of the loop on mount (same as toggleLoop), so a
	// default-on / restored session starts at the window head, not a wrapped
	// offset. Speed is seeded from the persisted preference.
	const [loopClock, setLoopClock] = useState<LoopClock>(() => ({
		anchorVirtual: nowMs - loopSettings.windowMinutes * 60_000,
		anchorWall: performance.now(),
		speed: loopSettings.speed,
		scrubbing: false,
		paused: false,
	}));
	const [playheadMs, setPlayheadMs] = useState(0);
	// Mutated in place; identity is stable so FlightMap's ref always sees the
	// latest samples without a re-render per insert.
	const replayBufferRef = useRef<ReplayBuffer>(new Map());
	// How many flightsHistory entries have been folded into the buffer (the
	// provider's array is append-only until it resets).
	const consumedHistoryRef = useRef(0);
	const windowMs = loopMinutes * 60_000;

	const toggleLoop = useCallback(() => {
		if (!loopEnabled) {
			// Start each session at the top of the loop, at the saved speed.
			setLoopClock({
				anchorVirtual: nowMs - loopMinutes * 60_000,
				anchorWall: performance.now(),
				speed: loopSettings.speed,
				scrubbing: false,
				paused: false,
			});
		} else {
			replayBufferRef.current = new Map();
			consumedHistoryRef.current = 0;
		}
		desktopEventDispatch(
			flightTrackerSetLoopSettings({ ...loopSettings, enabled: !loopEnabled }),
		);
	}, [loopEnabled, nowMs, loopMinutes, loopSettings, desktopEventDispatch]);

	// Slider drag: freeze at the dragged instant. Release: resume from there.
	const scrubTo = useCallback(
		(offsetSec: number, scrubbing: boolean) => {
			setLoopClock((c) => ({
				...c,
				anchorVirtual: nowMs - windowMs + offsetSec * 1000,
				anchorWall: performance.now(),
				scrubbing,
			}));
		},
		[nowMs, windowMs],
	);

	// Re-anchor at the current playhead so a speed change never jumps the ghosts,
	// and persist the new speed as a preference.
	const setLoopSpeed = useCallback(
		(speed: LoopSpeed) => {
			setLoopClock((c) => ({
				...c,
				speed,
				anchorVirtual: playheadMs,
				anchorWall: performance.now(),
			}));
			desktopEventDispatch(flightTrackerSetLoopSettings({ ...loopSettings, speed }));
		},
		[playheadMs, loopSettings, desktopEventDispatch],
	);

	// Play/pause. Re-anchor at the current playhead so resume picks up exactly
	// where it froze (same trick as a speed change).
	const togglePause = useCallback(() => {
		setLoopClock((c) => ({
			...c,
			paused: !c.paused,
			anchorVirtual: playheadMs,
			anchorWall: performance.now(),
		}));
	}, [playheadMs]);

	const appMenu = useMemo(
		() => [
			{
				id: "file",
				title: "File",
				menuChildren: [
					{
						id: "flight-settings-menu",
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
						// ClassicyMenuItem has no checked prop — the ✓ lives in the title.
						id: "flight-darkmap-menu",
						title: `${settings.darkMap ? "✓ " : ""}Dark Map`,
						onClickFunc: toggleDarkMap,
					},
					{
						id: "flight-radar-menu",
						title: `${settings.radarSweep ? "✓ " : ""}Radar Sweep`,
						onClickFunc: toggleRadarSweep,
					},
					{
						id: "flight-loop-menu",
						title: `${loopEnabled ? "✓ " : ""}Loop Playback`,
						onClickFunc: toggleLoop,
					},
				],
			},
		],
		[appIcon, settings.darkMap, settings.radarSweep, openSettings, toggleDarkMap, toggleRadarSweep, loopEnabled, toggleLoop],
	);

	// Loop on/off ↔ provider history request. The provider re-issues on
	// seek/reconnect by itself; window changes re-run this effect.
	useEffect(() => {
		if (!isRunning) return;
		if (loopEnabled) {
			requestFlightsHistory(loopMinutes);
		} else {
			clearFlightsHistory();
		}
	}, [isRunning, loopEnabled, loopMinutes, requestFlightsHistory, clearFlightsHistory]);

	// Fold history chunks into the replay buffer. Append-only consumption; a
	// length decrease means the provider reset (new request / seek) → start over.
	useEffect(() => {
		if (!loopEnabled) {
			consumedHistoryRef.current = 0;
			return;
		}
		if (flightsHistory.length < consumedHistoryRef.current) {
			replayBufferRef.current = new Map();
			consumedHistoryRef.current = 0;
		}
		insertReplaySamples(
			replayBufferRef.current,
			flightsHistory.slice(consumedHistoryRef.current),
		);
		consumedHistoryRef.current = flightsHistory.length;
	}, [flightsHistory, loopEnabled]);

	// Live positions are the sliding window's tail (insertion is idempotent);
	// prune keeps the buffer bounded as the window slides forward.
	useEffect(() => {
		if (!loopEnabled) return;
		insertReplaySamples(replayBufferRef.current, flightPositions);
		pruneReplay(replayBufferRef.current, nowMs - windowMs);
	}, [flightPositions, loopEnabled, nowMs, windowMs]);

	// Coarse playhead for the slider + time label (the map computes its own at
	// rAF rate from the same clock; 4 Hz is plenty for a 30-90 min slider).
	useEffect(() => {
		if (!loopEnabled) return;
		const update = () => {
			setPlayheadMs(playheadAt(loopClock, performance.now(), nowMs - windowMs, nowMs));
		};
		update();
		const id = setInterval(update, 250);
		return () => clearInterval(id);
	}, [loopEnabled, loopClock, nowMs, windowMs]);

	// Memoized: useFlightTrack's effect depends on [selection], so a fresh
	// object literal here would re-fetch the track on every render even when
	// the selected flight/date haven't changed. `selected` only gets a new
	// reference on a genuine selection change (onSelectFlight/onClearSelection),
	// so keying on it directly keeps `selection` stable across unrelated
	// re-renders (position ticks, connected-status flips, etc.).
	const selection: TrackSelection | null = useMemo(
		() =>
			selected
				? { flight: selected.flight, startDate: selected.start_date }
				: null,
		[selected],
	);
	const { track, loading, error } = useFlightTrack(selection);

	// Live fix for the selected flight (`selected` is a click-time snapshot; the
	// streamed set updates each minute-bucket). Heading is the bearing of the
	// track leg nearest that fix — no motion-buffer plumbing needed.
	const livePos = selected
		? (flightPositions.find((p) => p.flight === selected.flight) ?? selected)
		: null;
	const headingDeg = useMemo(
		() =>
			livePos && track?.geometry
				? headingFromTrack(track.geometry.coordinates, livePos.lat, livePos.lon)
				: null,
		[livePos, track],
	);

	// Clear the selection when the selected flight leaves the airborne set — e.g.
	// after a seek to a time it isn't aloft (spec: seek clears selection). Keyed on
	// `flight`, the streamed identity, not object reference.
	useEffect(() => {
		if (selected && !flightPositions.some((p) => p.flight === selected.flight)) {
			setSelected(null);
		}
	}, [flightPositions, selected]);

	// Selects the clicked flight if it's currently in the airborne set; does not
	// clear on seek itself — the effect above handles that.
	const onSelectFlight = (flight: string) => {
		const hit = flightPositions.find((p) => p.flight === flight) ?? null;
		if (hit) setSelected(hit);
	};

	const trackGeoJSON: Feature | null = track?.geometry
		? { type: "Feature", geometry: track.geometry, properties: {} }
		: null;

	return (
		<ClassicyApp id={appId} name={appName} icon={appIcon} defaultWindow="flight-map">
			{showSettings && (
				<ClassicyWindow
					id="flight-settings"
					title="Settings"
					appId={appId}
					closable={true}
					resizable={false}
					zoomable={false}
					scrollable={true}
					collapsable={false}
					initialSize={[360, 0]}
					initialPosition={[150, 120]}
					modal={true}
					appMenu={appMenu}
					onCloseFunc={() => setShowSettings(false)}
				>
					<div className={styles.settings}>
						<ClassicyCheckbox
							id="flight_settings_darkmap"
							label="Dark map"
							checked={form.darkMap}
							onClickFunc={(checked: boolean) =>
								setForm((f) => ({ ...f, darkMap: checked }))
							}
						/>
						<ClassicyCheckbox
							id="flight_settings_radar"
							label="Radar sweep"
							checked={form.radarSweep}
							onClickFunc={(checked: boolean) =>
								setForm((f) => ({ ...f, radarSweep: checked }))
							}
						/>
						<ClassicyColorPicker
							id="flight_settings_pin_color_light"
							labelTitle="Flight pins (light map)"
							value={form.pinColorLight}
							crayons={MAC_OS_8_CRAYONS}
							onChangeFunc={(color: number) =>
								setForm((f) => ({ ...f, pinColorLight: color }))
							}
						/>
						<ClassicyColorPicker
							id="flight_settings_pin_color_dark"
							labelTitle="Flight pins (dark map)"
							value={form.pinColorDark}
							crayons={MAC_OS_8_CRAYONS}
							onChangeFunc={(color: number) =>
								setForm((f) => ({ ...f, pinColorDark: color }))
							}
						/>
						<ClassicyColorPicker
							id="flight_settings_notable_pin_color_light"
							labelTitle="Notable flight pins (light map)"
							value={form.notablePinColorLight}
							crayons={MAC_OS_8_CRAYONS}
							onChangeFunc={(color: number) =>
								setForm((f) => ({ ...f, notablePinColorLight: color }))
							}
						/>
						<ClassicyColorPicker
							id="flight_settings_notable_pin_color_dark"
							labelTitle="Notable flight pins (dark map)"
							value={form.notablePinColorDark}
							crayons={MAC_OS_8_CRAYONS}
							onChangeFunc={(color: number) =>
								setForm((f) => ({ ...f, notablePinColorDark: color }))
							}
						/>
						<ClassicySlider
							id="flight_settings_trail_multiplier"
							labelTitle="Trail length"
							ariaLabel="Flight trail length multiplier"
							value={form.trailMultiplier}
							min={0}
							max={10}
							step={0.5}
							labelSize="small"
							valueLabel={form.trailMultiplier === 0 ? "Off" : `${form.trailMultiplier}×`}
							onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
								setForm((f) => ({ ...f, trailMultiplier: parseFloat(e.target.value) }))
							}
						/>
						<div className={styles.settingsButtons}>
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
				id="flight-map"
				title="Flight Tracker"
				appId={appId}
				initialSize={["80%", "80%"]}
				initialPosition={["center", "center"]}
				appMenu={appMenu}
				scrollable={false}
				resizable
				growable
				dimContents={false}
			>
				<div className={styles.root}>
					<div className={styles.body}>
						<div className={styles.map}>
							<FlightMap
								positions={flightPositions}
								basemapUrl={BASEMAP_URL}
								trackGeoJSON={trackGeoJSON}
								nowMs={nowMs}
								playing={!paused}
								darkMap={settings.darkMap}
								pinColor={intToHex(
									settings.darkMap ? settings.pinColorDark : settings.pinColorLight,
								)}
								notablePinColor={intToHex(
									settings.darkMap
										? settings.notablePinColorDark
										: settings.notablePinColorLight,
								)}
								radarSweep={settings.radarSweep}
								trailMultiplier={settings.trailMultiplier}
								loopEnabled={loopEnabled}
								loopWindowMs={windowMs}
								loopClock={loopClock}
								replayBuffer={replayBufferRef.current}
								onSelectFlight={onSelectFlight}
								onClearSelection={() => setSelected(null)}
							/>
						</div>
						<div style={{ width: "20%", flexShrink: 0, borderLeft: "var(--window-border-size) solid var(--color-black)", padding: "var(--window-padding-size)", backgroundColor: "var(--color-system-03)" }}>
						<FlightDetailPanel
							selected={selected}
							track={track}
							loading={loading}
							error={error}
							nowMs={nowMs}
							headingDeg={headingDeg}
							tzOffset={tzOffset}
						/>
						</div>
					</div>
					{loopEnabled && (
						<div className={styles.loopStrip}>
							<ClassicyButton
								onClickFunc={togglePause}
								aria-label={loopClock.paused ? "Play loop" : "Pause loop"}
							>
								{loopClock.paused ? "▶" : "⏸"}
							</ClassicyButton>
							<ClassicyPopUpMenu
								id="flight_loop_window"
								label="Time"
								labelPosition="left"
								labelSize="small"
								size="small"
								options={[
									{ value: "30", label: "30 min" },
									{ value: "90", label: "90 min" },
								]}
								selected={String(loopMinutes)}
								onChangeFunc={(e) =>
									desktopEventDispatch(
										flightTrackerSetLoopSettings({
											...loopSettings,
											windowMinutes: Number(e.target.value) as LoopWindowMinutes,
										}),
									)
								}
							/>
							<ClassicyPopUpMenu
								id="flight_loop_speed"
								label="Speed"
								labelPosition="left"
								labelSize="small"
								size="small"

								options={LOOP_SPEEDS.map((s) => ({
									value: String(s),
									label: SPEED_LABELS[s],
								}))}
								selected={String(loopClock.speed)}
								onChangeFunc={(e) =>
									setLoopSpeed(Number(e.target.value) as LoopSpeed)
								}
							/>
							<div className={styles.loopSlider}>
								<ClassicySlider
									id="flight_loop_scrub"
									value={Math.round(
										Math.min(
											Math.max((playheadMs - (nowMs - windowMs)) / 1000, 0),
											windowMs / 1000,
										),
									)}
									valueLabel={formatPlayhead(playheadMs, tzOffset)}
									min={0}
									max={windowMs / 1000}
									step={1}
									ariaLabel="Loop playhead"
									onChangeFunc={(e) => scrubTo(Number(e.target.value), true)}
									onCommitFunc={(v: number) => scrubTo(v, false)}
								/>
							</div>
						</div>
					)}
					<div className={styles.statusBar}>
						<span>
							<span style={{ color: connected ? "green" : "red" }}>&bull;</span>{" "}
							{connected ? (loopEnabled ? "Live (Loop)" : "Live") : "Disconnected"}
						</span>
						<span>{flightPositions.length} aircraft aloft</span>
					</div>
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};
