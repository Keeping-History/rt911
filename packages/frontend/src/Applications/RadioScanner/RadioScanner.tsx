import {
    ClassicyApp,
    ClassicyButton,
    ClassicyCheckbox,
    ClassicyColorPicker,
    ClassicyControlGroup,
    ClassicyIcons,
    ClassicyRadioInput,
    ClassicySlider,
    ClassicyWindow,
    intToHex,
    MAC_OS_8_CRAYONS,
    quitMenuItemHelper,
    useAppManager,
    useAppManagerDispatch,
    useClassicyDateTime,
} from "classicy";
import type React from "react";
import {
    type ChangeEvent,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { FocusedItemPlayer } from "./FocusedItemPlayer";
import { NowPlayingList } from "./NowPlayingList";
import styles from "./RadioScanner.module.scss";
import "./RadioScannerContext";
import { trackAppToggle } from "../../openreplay";
import { isAudioBlocked, subscribeAudioBlocked } from "./audioBlocked";
import {
    effectiveMutedIds,
    sanitizeActiveStation,
    sanitizeItemIds,
} from "./radioPlayback";
import {
    DEFAULT_RADIO_SCANNER_SETTINGS,
    isVizMode,
    nextVizMode,
    radioScannerSetSettings,
    type RadioScannerSettings,
    readRadioScannerSettings,
    VIZ_MODES,
} from "./radioScannerSettings";
import { StationPlayer } from "./StationPlayer";
import {
    activeSegments,
    countdownLabel,
    mergeWithSources,
    previousSegments,
    sortStations,
    startTimeLabel,
    upcomingSegments,
} from "./stationGrouping";
import { StationButtonContent } from "./StationButtonContent";

type RadioScannerProps = Record<string, never>;

// These stations are continuous broadcasts — no Coming Up / Previous schedule.
const CONTINUOUS_STATIONS = new Set(["WCBS", "WINS"]);

export const RadioScanner: React.FC<RadioScannerProps> = () => {
    const appName = "Radio Scanner";
    const appId = "RadioScanner.app";
    const appIcon = ClassicyIcons.applications.radio.app as string;

    const desktopEventDispatch = useAppManagerDispatch();
    const appState = useAppManager(
        (state) =>
            state.System.Manager.Applications.apps[appId]?.data as
                | Record<string, unknown>
                | undefined,
    );

    // Waveform preferences — persisted under data.settings, distinct from the
    // SetState fields below. The overlay toggle and the Settings window both
    // write through saveSettings.
    const settings = useMemo(
        () => readRadioScannerSettings(appState),
        [appState],
    );

    const saveSettings = useCallback(
        (next: RadioScannerSettings) =>
            desktopEventDispatch(radioScannerSetSettings(next)),
        [desktopEventDispatch],
    );

    const onCycleVizMode = useCallback(() => {
        saveSettings({ ...settings, vizMode: nextVizMode(settings.vizMode) });
    }, [saveSettings, settings]);

    const waveColors = useMemo(
        () =>
            settings.useThemeColors
                ? null
                : {
                        bright: intToHex(settings.colorBright),
                        dim: intToHex(settings.colorDim),
                    },
        [settings],
    );

    // Settings store percent (slider-native); players take a 0..1 fraction.
    const maxVolume = settings.maxVolume / 100;

    // Settings window draft (TimeMachine pattern): seeded from the persisted
    // settings on open, dispatched only on Save.
    const [showSettings, setShowSettings] = useState(false);
    const [settingsForm, setSettingsForm] = useState<RadioScannerSettings>(
        DEFAULT_RADIO_SCANNER_SETTINGS,
    );
    const openSettings = useCallback(() => {
        setSettingsForm(settings);
        setShowSettings(true);
    }, [settings]);
    const saveSettingsForm = useCallback(() => {
        saveSettings(settingsForm);
        setShowSettings(false);
    }, [saveSettings, settingsForm]);

    const isOpen = useAppManager(
        (state) => state.System.Manager.Applications.apps[appId]?.open ?? false,
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

    const {
        mp3Items: items,
        mp3History,
        subscribeMp3,
        unsubscribeMp3,
        sources,
        getUpcomingMp3Items,
    } = useContext(MediaStreamContext);
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only
    useEffect(() => {
        subscribeMp3(appId);
        return () => unsubscribeMp3(appId);
    }, [subscribeMp3, unsubscribeMp3, appId]);

    const { dateTime, paused: clockPaused, tzOffset } = useClassicyDateTime();

    const [captionsOn, setCaptionsOn] = useState<boolean>(false);
    const [activeStation, setActiveStation] = useState<string>(
        sanitizeActiveStation(appState?.activeStation),
    );
    const [mutedItems, setMutedItems] = useState<number[]>(
        sanitizeItemIds(appState?.mutedItems),
    );
    const [showWaveform, setShowWaveform] = useState<boolean>(
        (appState?.showWaveform as boolean) ?? true,
    );
    const [focusedItem, setFocusedItem] = useState<MediaItem | null>(null);
    // Solo (ephemeral, not persisted): while set, every other playing item is
    // muted via effectiveMutedIds and the now-playing marquee pauses. Manual
    // mutedItems stay untouched, so un-soloing restores them exactly.
    const [soloItemId, setSoloItemId] = useState<number | null>(null);

    // Accumulate all mp3Items ever received so previousSegments can access them
    // even after they expire from the live stream.
    const seenItemsRef = useRef<Map<number, MediaItem>>(new Map());
    useEffect(() => {
        for (const item of items) {
            seenItemsRef.current.set(item.id, item);
        }
    }, [items]);

    // Fine virtual clock: the stored dateTime advances per minute, so add the
    // real time elapsed since its last update to recover sub-minute precision.
    const dateTimeRef = useRef(dateTime);
    dateTimeRef.current = dateTime;
    const clockPausedRef = useRef(clockPaused);
    clockPausedRef.current = clockPaused;
    const dateTimeUpdatedAtRef = useRef<number>(Date.now());
    // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
    useEffect(() => {
        dateTimeUpdatedAtRef.current = Date.now();
    }, [dateTime]);

    const getNowMs = useCallback(() => {
        const elapsed = clockPausedRef.current
            ? 0
            : Date.now() - dateTimeUpdatedAtRef.current;
        return new Date(dateTimeRef.current).getTime() + elapsed;
    }, []);
    const nowMs = getNowMs();

    // Re-render every second so nowMs tracks the clock at ~1s resolution.
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, []);

    const stations = useMemo(
        () => mergeWithSources(sources.audio, items),
        [sources.audio, items],
    );

    // Snapshot of items waiting in the reveal buffer — refreshed every second.
    // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the intended dependency
    const upcomingItems = useMemo(
        () => getUpcomingMp3Items(),
        [tick, getUpcomingMp3Items], // eslint-disable-line react-hooks/exhaustive-deps
    );

    // Select the first station once stations arrive.
    useEffect(() => {
        if (activeStation === "" && stations.length > 0) {
            setActiveStation(stations[0].key);
        }
    }, [stations, activeStation]);

    // Persist state on every change.
    useEffect(() => {
        desktopEventDispatch({
            type: "ClassicyAppRadioScannerSetState",
            activeStation,
            mutedItems,
            showWaveform,
        });
    }, [activeStation, mutedItems, showWaveform, desktopEventDispatch]);

    const toggleItemMute = (id: number) => {
        setMutedItems((prev) =>
            prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
        );
    };

    const toggleSoloItem = useCallback((id: number) => {
        setSoloItemId((prev) => (prev === id ? null : id));
    }, []);

    // Solo is scoped to the station it was started on.
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset-on-change effect
    useEffect(() => {
        setSoloItemId(null);
    }, [activeStation]);

    const appMenu = [
        {
            id: "file",
            title: "File",
            menuChildren: [
                {
                    id: "settings",
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
                    id: "toggle-waveform",
                    title: `${showWaveform ? "✓ " : "  "}Show Waveform`,
                    onClickFunc: () => setShowWaveform((v) => !v),
                },
            ],
        },
    ];

    const activeStationObj = stations.find((s) => s.key === activeStation);

    // The active station's in-window segments — shared by the now-playing
    // list, the solo lifecycle, and the effective-mute derivation. Memoized so
    // the no-solo playerMutedItems keeps mutedItems' identity and the volume
    // effect in StationPlayer doesn't re-fire on unrelated renders.
    // biome-ignore lint/correctness/useExhaustiveDependencies: nowMs is the clock dep
    const playingSegments = useMemo(
        () => (activeStationObj ? activeSegments(activeStationObj, nowMs) : []),
        [activeStationObj, nowMs],
    );

    // A soloed clip that finishes (or expires on seek) releases the solo, so
    // the rest of the mix comes back rather than staying silent.
    useEffect(() => {
        if (
            soloItemId !== null &&
            !playingSegments.some((i) => i.id === soloItemId)
        ) {
            setSoloItemId(null);
        }
    }, [playingSegments, soloItemId]);

    // What the audio elements actually honor: manual mutes, or — while a solo
    // is active — everything in the mix except the soloed item.
    const playerMutedItems = useMemo(
        () =>
            effectiveMutedIds(
                mutedItems,
                soloItemId,
                playingSegments.map((i) => i.id),
            ),
        [mutedItems, soloItemId, playingSegments],
    );

    const showSchedule =
        activeStation !== "" && !CONTINUOUS_STATIONS.has(activeStation);

    // True while the browser's autoplay policy is holding audio back (Safari
    // refuses gesture-less sound on page load). The document-level unlock
    // listeners in audioCapture.ts / StationPlayer.tsx make any click the fix,
    // so the overlay below only has to ask for one.
    const audioBlocked = useSyncExternalStore(
        subscribeAudioBlocked,
        isAudioBlocked,
    );

    const upcomingList =
        showSchedule && activeStationObj
            ? upcomingSegments(activeStationObj, upcomingItems, nowMs)
            : [];

    // Previous = the server's full back-catalogue (everything started before the
    // snapshot instant) plus items seen live since (which cover the gap between
    // history snapshots). Later-seen copies win the id merge; previousSegments
    // keeps only entries that have actually ended by nowMs.
    const previousList =
        showSchedule && activeStationObj
            ? previousSegments(
                  activeStationObj,
                  Array.from(
                      new Map(
                          [...mp3History, ...seenItemsRef.current.values()].map(
                              (i) => [i.id, i],
                          ),
                      ).values(),
                  ),
                  nowMs,
              )
            : [];

    // Pinned stations first, then online stations, then offline ones.
    const sortedStations = useMemo(
        () => sortStations(stations, nowMs),
        [stations, nowMs],
    );

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
                    title="Settings"
                    icon={appIcon}
                    appId={appId}
                    closable={true}
                    resizable={false}
                    zoomable={false}
                    scrollable={false}
                    collapsable={false}
                    initialSize={[370, 0]}
                    initialPosition={[250, 150]}
                    modal={true}
                    appMenu={appMenu}
                    onCloseFunc={() => setShowSettings(false)}
                >
                    <div className={styles.rsSettings}>
                        <ClassicyControlGroup label="Waveform Style">
                            <ClassicyRadioInput
                                name="radioscanner_settings_viz_mode"
                                inputs={VIZ_MODES.map((m) => ({
                                    id: m,
                                    label: m,
                                    checked: settingsForm.vizMode === m,
                                }))}
                                onClickFunc={(id: string) =>
                                    setSettingsForm((f) =>
                                        isVizMode(id) ? { ...f, vizMode: id } : f,
                                    )
                                }
                            />
                        </ClassicyControlGroup>
                        <ClassicyControlGroup label="Waveform Colors">
                            <ClassicyCheckbox
                                id="radioscanner_settings_use_theme"
                                label="Use theme colors"
                                checked={settingsForm.useThemeColors}
                                onClickFunc={(checked: boolean) =>
                                    setSettingsForm((f) => ({
                                        ...f,
                                        useThemeColors: checked,
                                    }))
                                }
                            />
                            {!settingsForm.useThemeColors && (
                                <>
                                    <ClassicyColorPicker
                                        id="radioscanner_settings_color_bright"
                                        labelTitle="Bright"
                                        value={settingsForm.colorBright}
                                        crayons={MAC_OS_8_CRAYONS}
                                        onChangeFunc={(color: number) =>
                                            setSettingsForm((f) => ({
                                                ...f,
                                                colorBright: color,
                                            }))
                                        }
                                    />
                                    <ClassicyColorPicker
                                        id="radioscanner_settings_color_dim"
                                        labelTitle="Dim"
                                        value={settingsForm.colorDim}
                                        crayons={MAC_OS_8_CRAYONS}
                                        onChangeFunc={(color: number) =>
                                            setSettingsForm((f) => ({
                                                ...f,
                                                colorDim: color,
                                            }))
                                        }
                                    />
                                </>
                            )}
                        </ClassicyControlGroup>
                        <ClassicyControlGroup label="Volume">
                            <ClassicySlider
                                id="radioscanner_settings_max_volume"
                                labelTitle="Max volume:"
                                labelPosition="left"
                                value={settingsForm.maxVolume}
                                min={0}
                                max={100}
                                step={1}
                                valueLabel={`${settingsForm.maxVolume}%`}
                                onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
                                    setSettingsForm((f) => ({
                                        ...f,
                                        maxVolume: parseInt(e.target.value, 10),
                                    }))
                                }
                            />
                        </ClassicyControlGroup>
                        <div className={styles.rsSettingsButtons}>
                            <ClassicyButton onClickFunc={() => setShowSettings(false)}>
                                Cancel
                            </ClassicyButton>
                            <ClassicyButton
                                isDefault={true}
                                onClickFunc={saveSettingsForm}
                            >
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
                initialSize={["50%", "50%"]}
                initialPosition={["left", "top"]}
                minimumSize={[500, 280]}
                modal={false}
                appMenu={appMenu}
            >
                <div className={styles.rsContainer}>
                    {audioBlocked && (
                        <div className={styles.rsUnlockOverlay}>
                            <div className={styles.rsUnlockOverlayBox}>
                                <p className={styles.rsUnlockOverlayTitle}>
                                    Click anywhere to start audio
                                </p>
                                <p className={styles.rsUnlockOverlayHint}>
                                    Your browser paused sound until you
                                    interact with the page
                                </p>
                            </div>
                        </div>
                    )}
                    <div className={styles.rsMainArea}>
                        {focusedItem ? (
                            <FocusedItemPlayer
                                item={focusedItem}
                                onDismiss={() => setFocusedItem(null)}
                                showWaveform={showWaveform}
                                vizMode={settings.vizMode}
                                onCycleVizMode={onCycleVizMode}
                                waveColors={waveColors}
                                maxVolume={maxVolume}
                            />
                        ) : (
                            activeStationObj && (
                                <>
                                    <div className={styles.rsDisplay}>
                                        <p className={styles.rsDisplaySource}>
                                            {activeStationObj.label}
                                        </p>
                                        <NowPlayingList
                                            segments={playingSegments}
                                            mutedItems={mutedItems}
                                            onToggleMute={toggleItemMute}
                                            soloItemId={soloItemId}
                                            onToggleSolo={toggleSoloItem}
                                        />
                                        {showSchedule && (
                                        <div style={{ display: "flex", flexDirection: "row", width: "100%", minHeight: "30%", maxHeight: "60%", gap: "var(--window-control-size)" }}>
                                                <div
                                                    className={
                                                        styles.rsScheduleSection
                                                    }
                                                >
                                                    <p
                                                        className={
                                                            styles.rsScheduleLabel
                                                        }
                                                    >
                                                        Coming Up
                                                    </p>
                                            {upcomingList.length > 0 && (
                                                    <ul
                                                        className={
                                                            styles.rsScheduleList
                                                        }
                                                    >
                                                        {upcomingList.map(
                                                            (item) => (
                                                                <li
                                                                    key={
                                                                        item.id
                                                                    }
                                                                    className={
                                                                        styles.rsScheduleItem
                                                                    }
                                                                >
																	<img src={ ClassicyIcons.controlPanels.soundManager.sound33} alt={item.title} />
                                                                    <span
                                                                        className={
                                                                            styles.rsCountdown
                                                                        }
                                                                    >
                                                                        {countdownLabel(
                                                                            item,
                                                                            nowMs,
                                                                        )}
                                                                    </span>
                                                                    {item.full_title ||
                                                                        item.title}
                                                                </li>
                                                            ),
                                                        )}
                                                    </ul>
                                            )}
											</div>
                                            {previousList.length > 0 && (
                                                <div
                                                    className={
                                                        styles.rsScheduleSection
                                                    }
                                                >
                                                    <p
                                                        className={
                                                            styles.rsScheduleLabel
                                                        }
                                                    >
                                                        Previous
                                                    </p>
                                                    <ul
                                                        className={
                                                            styles.rsScheduleList
                                                        }
                                                    >
                                                        {previousList.map(
                                                            (item) => (
                                                                <li
                                                                    key={
                                                                        item.id
                                                                    }
                                                                    className={
                                                                        styles.rsScheduleItem
                                                                    }
                                                                >
																	<img src={ ClassicyIcons.controlPanels.soundManager.sound33} alt={item.title} />
                                                                    <span
                                                                        className={
                                                                            styles.rsCountdown
                                                                        }
                                                                    >
                                                                        {startTimeLabel(
                                                                            item,
                                                                            tzOffset,
                                                                        )}
                                                                    </span>
                                                                    <button
                                                                        type="button"
                                                                        className={
                                                                            styles.rsScheduleBtn
                                                                        }
                                                                        onMouseUp={() =>
                                                                            setFocusedItem(
                                                                                item,
                                                                            )
                                                                        }
                                                                    >
                                                                        {item.full_title ||
                                                                            item.title}
                                                                    </button>
                                                                </li>
                                                            ),
                                                        )}
                                                    </ul>
                                                </div>
                                            )}
                                        </div>
                                        )}
                                    </div>
                                    <StationPlayer
                                        station={activeStationObj}
                                        nowMs={nowMs}
                                        getNowMs={getNowMs}
                                        stationMuted={false}
                                        mutedItems={playerMutedItems}
                                        clockPaused={clockPaused}
                                        showWaveform={showWaveform}
                                        captionsOn={captionsOn}
                                        vizMode={settings.vizMode}
                                        onCycleVizMode={onCycleVizMode}
                                        waveColors={waveColors}
                                        maxVolume={maxVolume}
                                    />
                                </>
                            )
                        )}
                    </div>

                    {/* Bottom row: control panel + one button per station */}
                    <div className={styles.rsBottomRow}>
                        <div className={styles.rsControlPanel}>
                            <ClassicyButton
                                buttonSize="small"
                                onClickFunc={() => setCaptionsOn((v) => !v)}
                                depressed={captionsOn}
                            >
                                {captionsOn ? "CC On" : "CC Off"}
                            </ClassicyButton>
                        </div>
                        <div className={styles.rsStationStrip}>
                            {sortedStations.map((station) => {
                                const isActive = station.key === activeStation;
                                const isOnline =
                                    activeSegments(station, nowMs).length > 0;
                                return (
                                    <ClassicyButton
                                        key={station.key}
                                        depressed={isActive}
                                        onClickFunc={() => {
                                            setActiveStation(station.key);
                                            setFocusedItem(null);
                                        }}
                                    >
                                        <StationButtonContent
                                            label={station.label}
                                            offline={!isOnline}
                                        />
                                    </ClassicyButton>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </ClassicyWindow>
        </ClassicyApp>
    );
};
