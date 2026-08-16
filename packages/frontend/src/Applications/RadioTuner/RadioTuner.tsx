import {
    ClassicyApp,
    ClassicyButton,
    ClassicyIcons,
    ClassicyWindow,
    intToHex,
    quitMenuItemHelper,
    useAppManager,
    useAppManagerDispatch,
    useClassicyDateTime,
} from "classicy";
import { manifestDescription } from "../../Components/manifestDescription";
import type React from "react";
import {
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { useAboutApp } from "../../Components/AboutApp/AboutApp";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { trackAppToggle } from "../../openreplay";
import { isAudioBlocked, subscribeAudioBlocked } from "../RadioScanner/audioBlocked";
// import { NowPlayingList } from "./NowPlayingList";
import {
    effectiveMutedIds,
    sanitizeActiveStation,
    sanitizeItemIds,
} from "../RadioScanner/radioPlayback";
import styles from "../RadioScanner/RadioScanner.module.scss";
import {
    DEFAULT_RADIO_SCANNER_SETTINGS,
    nextVizMode,
    type RadioScannerSettings,
    readRadioScannerSettings,
} from "../RadioScanner/radioScannerSettings";
import { RadioSettingsWindow } from "../RadioScanner/RadioSettingsWindow";
import { StationButtonContent } from "../RadioScanner/StationButtonContent";
import { StationPlayer } from "../RadioScanner/StationPlayer";
import {
    activeSegments,
    BROADCAST_STATIONS,
    mergeWithSources,
    sortStationsByStatusAndLabel,
    stationLogo,
    stationStatus,
} from "../RadioScanner/stationGrouping";
import "./RadioTunerContext";
import type { RadioTunerRemoteCommand } from "./RadioTunerContext";
import { radioTunerSetSettings } from "./RadioTunerContext";

type RadioTunerProps = Record<string, never>;

/**
 * The Radio Tuner: full-run live radio broadcasts (WCBS, 1010 WINS — see
 * BROADCAST_STATIONS) played continuously against the virtual clock. Visually
 * the Radio Scanner's sibling — same strip/display/player chrome — but with
 * none of the scanner's short-clip machinery: continuous stations have no
 * Coming Up / Previous schedule and no "All Traffic" aggregate.
 */
export const RadioTuner: React.FC<RadioTunerProps> = () => {
    const appName = "Radio Tuner";
    const appId = "RadioTuner.app";
    const appIcon = ClassicyIcons.applications.radio.app as string;
    const aboutWindow = useAboutApp(appId, appIcon);

    const desktopEventDispatch = useAppManagerDispatch();
    const appState = useAppManager(
        (state) =>
            state.System.Manager.Applications.apps[appId]?.data as
            | Record<string, unknown>
            | undefined,
    );

    // Waveform/caption preferences — the same RadioScannerSettings shape the
    // scanner persists, stored under this app's own data.settings.
    const settings = useMemo(
        () => readRadioScannerSettings(appState),
        [appState],
    );

    const saveSettings = useCallback(
        (next: RadioScannerSettings) =>
            desktopEventDispatch(radioTunerSetSettings(next)),
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

    const { dateTime, paused: clockPaused } = useClassicyDateTime();

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
    // Solo (ephemeral, not persisted): while set, every other playing item is
    // muted via effectiveMutedIds. Manual mutedItems stay untouched, so
    // un-soloing restores them exactly.
    const [soloItemId, setSoloItemId] = useState<number | null>(null);

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

    // Only the continuous broadcast stations — the comm-traffic sources are the
    // Radio Scanner's, and this filter is the flip side of the scanner's.
    const stations = useMemo(
        () =>
            mergeWithSources(sources.audio, items).filter((s) =>
                BROADCAST_STATIONS.has(s.key),
            ),
        [sources.audio, items],
    );

    // Snapshot of items waiting in the reveal buffer — refreshed every second.
    // Feeds the strip's on-air/upcoming/offline indicator lights only.
    // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the intended dependency
    const upcomingItems = useMemo(
        () => getUpcomingMp3Items(),
        [tick, getUpcomingMp3Items], // eslint-disable-line react-hooks/exhaustive-deps
    );

    // Strip display order: on-air, then upcoming, then offline, alphabetical
    // by call sign within each tier. Recomputed each tick (nowMs/upcomingItems)
    // so buttons re-bucket as stations sign on and off.
    // biome-ignore lint/correctness/useExhaustiveDependencies: nowMs is the clock dep
    const stripStations = useMemo(
        () => sortStationsByStatusAndLabel(stations, upcomingItems, nowMs),
        [stations, upcomingItems, nowMs],
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
            type: "ClassicyAppRadioTunerSetState",
            activeStation,
            mutedItems,
            showWaveform,
        });
    }, [activeStation, mutedItems, showWaveform, desktopEventDispatch]);

    // Apply each remote tune command (playlist engine, etc.) exactly once,
    // tracked by its monotonic seq — the scanner's command pattern. If the
    // station isn't in the list yet, the seq is left unconsumed so the effect
    // retries when `stations` updates.
    const command = appState?.command as RadioTunerRemoteCommand | undefined;
    const lastCommandSeqRef = useRef(0);
    useEffect(() => {
        if (!command || command.seq <= lastCommandSeqRef.current) return;
        if (command.kind !== "tune") {
            lastCommandSeqRef.current = command.seq;
            return;
        }
        const lc = command.station.toLowerCase();
        const match = stations.find((s) => s.key.toLowerCase() === lc);
        if (!match) return; // not in the list yet — retry on next update
        lastCommandSeqRef.current = command.seq;
        setActiveStation(match.key);
    }, [command, stations]);

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

    // Station artwork from the streamed mp3_items rows' `image` field — the
    // text call sign stays as the fallback (and the image's alt) for stations
    // whose rows carry no artwork.
    const activeLogo = activeStationObj
        ? stationLogo(activeStationObj, upcomingItems)
        : undefined;

    // The active station's in-window segments — shared by the now-playing
    // list, the solo lifecycle, and the effective-mute derivation.
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
                playingSegments.map((i: MediaItem) => i.id),
            ),
        [mutedItems, soloItemId, playingSegments],
    );

    // True while the browser's autoplay policy is holding audio back — same
    // document-level unlock listeners the scanner relies on.
    const audioBlocked = useSyncExternalStore(
        subscribeAudioBlocked,
        isAudioBlocked,
    );

    return (
        <ClassicyApp
            id={appId}
            name={appName}
            icon={appIcon}
            defaultWindow={`${appId}_main`}
            desktopIconBalloonHelp={manifestDescription(appId)}
        >
            {showSettings && (
                <RadioSettingsWindow
                    appId={appId}
                    appIcon={appIcon}
                    appMenu={appMenu}
                    idPrefix="radiotuner_settings"
                    form={settingsForm}
                    setForm={setSettingsForm}
                    onCancel={() => setShowSettings(false)}
                    onSave={saveSettingsForm}
                />
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
                initialSize={["50%", "40%"]}
                initialPosition={["center", "top"]}
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
                        {activeStationObj && (
                            <>
                                <div className={styles.rsDisplay}>
                                    {activeLogo ? (
                                        <img
                                            className={styles.rsDisplayLogo}
                                            src={activeLogo}
                                            alt={activeStationObj.label}
                                        />
                                    ) : (
                                        <p className={styles.rsDisplaySource}>
                                            {activeStationObj.label}
                                        </p>
                                    )}
                                    {/* <NowPlayingList
                                        segments={playingSegments}
                                        mutedItems={mutedItems}
                                        onToggleMute={toggleItemMute}
                                        soloItemId={soloItemId}
                                        onToggleSolo={toggleSoloItem}
                                    /> */}

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
                                    captionStyle={settings.captionStyle}
                                    vizMode={settings.vizMode}
                                    onCycleVizMode={onCycleVizMode}
                                    waveColors={waveColors}
                                    maxVolume={maxVolume}
                                    playOriginalAudio={settings.playOriginalAudio}
                                />
                            </>
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
                            {stripStations.map((station) => {
                                const isActive = station.key === activeStation;
                                return (
                                    <ClassicyButton
                                        key={station.key}
                                        depressed={isActive}
                                        onClickFunc={() =>
                                            setActiveStation(station.key)
                                        }
                                    >
                                        <StationButtonContent
                                            label={station.label}
                                            status={stationStatus(
                                                station,
                                                upcomingItems,
                                                nowMs,
                                            )}
                                        />
                                    </ClassicyButton>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </ClassicyWindow>
            {aboutWindow}
        </ClassicyApp>
    );
};
