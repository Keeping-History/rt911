import {
	ClassicyApp,
	ClassicyButton,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import type React from "react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import { NowPlayingList } from "./NowPlayingList";
import styles from "./RadioScanner.module.scss";
import "./RadioScannerContext";
import { sanitizeActiveStation, sanitizeItemIds, sanitizeStationKeys } from "./radioPlayback";
import { StationPlayer } from "./StationPlayer";
import { activeSegments, mergeWithSources } from "./stationGrouping";

type RadioScannerProps = Record<string, never>;

export const RadioScanner: React.FC<RadioScannerProps> = () => {
	const appName = "Radio Scanner";
	const appId = "RadioScanner.app";
	const appIcon = ClassicyIcons.controlPanels.soundManager.app as string;

	const desktopEventDispatch = useAppManagerDispatch();
	// Narrow to .data so that focus-only writes (apps[appId].focused) don't
	// create a new reference — Immer preserves .data when only siblings change.
	const appState = useAppManager(
		(state) => state.System.Manager.Applications.apps[appId]?.data as Record<string, unknown> | undefined,
	);

	// mp3 audio is delivered on its own opt-in channel; subscribe while mounted.
	// Mount-only: the component only renders when the app is open, so there is no
	// need to re-subscribe on every appState change (focus writes, data persist).
	const { mp3Items: items, subscribeMp3, unsubscribeMp3, sources } = useContext(MediaStreamContext);
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
	const [scannerMode, setScannerMode] = useState<boolean>(
		(appState?.scannerMode as boolean) ?? false,
	);
	const [selectedStations, setSelectedStations] = useState<string[]>(
		sanitizeStationKeys(appState?.selectedStations),
	);
	const [mutedStations, setMutedStations] = useState<string[]>(
		sanitizeStationKeys(appState?.mutedStations),
	);
	const [mutedItems, setMutedItems] = useState<number[]>(
		sanitizeItemIds(appState?.mutedItems),
	);
	const [showWaveform, setShowWaveform] = useState<boolean>(
		(appState?.showWaveform as boolean) ?? true,
	);

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

	// The stored dateTime only advances per minute, but in-window segment
	// membership must update promptly as segments start/end. Re-render every
	// second so nowMs (and the mounted players) track the clock at ~1s.
	const [, setTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, []);

	const stations = useMemo(
		() => mergeWithSources(sources.audio, items),
		[sources.audio, items],
	);

	// Select the first station once stations arrive (single-station mode).
	useEffect(() => {
		if (activeStation === "" && stations.length > 0) {
			setActiveStation(stations[0].key);
		}
	}, [stations, activeStation]);

	// Persist scanner layout, mute and waveform state on every change.
	useEffect(() => {
		desktopEventDispatch({
			type: "ClassicyAppRadioScannerSetState",
			activeStation,
			scannerMode,
			selectedStations,
			mutedStations,
			mutedItems,
			showWaveform,
		});
	}, [activeStation, scannerMode, selectedStations, mutedStations, mutedItems, showWaveform, desktopEventDispatch]);

	const toggleScanner = () => {
		setScannerMode((prev) => {
			const entering = !prev;
			setSelectedStations(entering && activeStation ? [activeStation] : []);
			// Station-level mutes are scoped to the scan-mode grid, so reset them on
			// a mode switch. Per-file mutes (mutedItems) are station-agnostic and
			// intentionally preserved across mode switches.
			setMutedStations([]);
			return entering;
		});
	};

	const toggleStationSelection = (key: string) => {
		setSelectedStations((prev) =>
			prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
		);
	};

	const toggleStationMute = (key: string) => {
		setMutedStations((prev) =>
			prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
		);
	};

	const toggleItemMute = (id: number) => {
		setMutedItems((prev) =>
			prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
		);
	};

	const gridColumns = Math.ceil(Math.sqrt(Math.max(1, selectedStations.length)));

	const appMenu = [
		{
			id: "file",
			title: "File",
			menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
		},
		{
			id: "view",
			title: "View",
			menuChildren: [
				{
					id: "toggle-waveform",
					// ClassicyMenuItem has no `checked` field; prefix a ✓ when on.
					title: `${showWaveform ? "✓ " : "  "}Show Waveform`,
					onClickFunc: () => setShowWaveform((v) => !v),
				},
			],
		},
	];

	const activeStationObj = stations.find((s) => s.key === activeStation);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={`${appId}_main`}
		>
			<ClassicyWindow
				id={`${appId}_main`}
				title={appName}
				appId={appId}
				closable={true}
				resizable={true}
				zoomable={true}
				scrollable={false}
				collapsable={true}
				initialSize={[700, 400]}
				initialPosition={[150, 80]}
				minimumSize={[500, 280]}
				modal={false}
				appMenu={appMenu}
			>
				<div className={styles.rsContainer}>
					<div className={styles.rsMainArea}>
						{/* Single-station mode: now-playing list + one station player */}
						{!scannerMode && activeStationObj && (
							<>
								<div className={styles.rsDisplay}>
									<p className={styles.rsDisplaySource}>{activeStationObj.label}</p>
									<NowPlayingList
										segments={activeSegments(activeStationObj, nowMs)}
										mutedItems={mutedItems}
										onToggleMute={toggleItemMute}
									/>
								</div>
								<StationPlayer
									station={activeStationObj}
									nowMs={nowMs}
									getNowMs={getNowMs}
									stationMuted={mutedStations.includes(activeStationObj.key)}
									mutedItems={mutedItems}
									clockPaused={clockPaused}
									showWaveform={showWaveform}
									captionsOn={captionsOn}
								/>
							</>
						)}

						{/* Scanner mode: grid of selected stations, each its own player */}
						{scannerMode && selectedStations.length > 0 && (
							<div
								className={styles.rsGrid}
								style={{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }}
							>
								{selectedStations.map((key) => {
									const station = stations.find((s) => s.key === key);
									if (!station) return null;
									const isMuted = mutedStations.includes(key);
									return (
										<div key={key} className={styles.rsGridStation}>
											<div className={styles.rsGridStationControls}>
												<button
													className={styles.rsGridControlBtn}
													type="button"
													onMouseUp={() => toggleStationMute(key)}
												>
													<img
														src={
															isMuted
																? (ClassicyIcons.controlPanels.soundManager
																		.soundMute as string)
																: (ClassicyIcons.controlPanels.soundManager
																		.soundOn as string)
														}
														alt={isMuted ? "Unmute" : "Mute"}
													/>
												</button>
												<button
													className={styles.rsGridControlBtn}
													type="button"
													onMouseUp={() => toggleStationSelection(key)}
												>
													✕
												</button>
											</div>
											<p className={styles.rsGridStationSource}>{station.label}</p>
											<NowPlayingList
												segments={activeSegments(station, nowMs)}
												mutedItems={mutedItems}
												onToggleMute={toggleItemMute}
											/>
											<StationPlayer
												station={station}
												nowMs={nowMs}
												getNowMs={getNowMs}
												stationMuted={isMuted}
												mutedItems={mutedItems}
												clockPaused={clockPaused}
												showWaveform={showWaveform}
												captionsOn={captionsOn}
											/>
										</div>
									);
								})}
							</div>
						)}
					</div>

					{/* Bottom row: control panel + one button per station */}
					<div className={styles.rsBottomRow}>
						<div className={styles.rsControlPanel}>
							<ClassicyButton onClickFunc={toggleScanner} depressed={scannerMode}>
								Scan
							</ClassicyButton>
							<ClassicyButton
								onClickFunc={() => setCaptionsOn((v) => !v)}
								depressed={captionsOn}
							>
								{captionsOn ? "CC On" : "CC Off"}
							</ClassicyButton>
						</div>
						<div className={styles.rsStationStrip}>
							{stations.map((station) => {
								const isActive = !scannerMode && station.key === activeStation;
								const isSelected = selectedStations.includes(station.key);
								return (
									<ClassicyButton
										key={station.key}
										depressed={isActive || isSelected}
										onClickFunc={() => {
											if (scannerMode) toggleStationSelection(station.key);
											else setActiveStation(station.key);
										}}
									>
										<p className={styles.rsStationSource}>{station.label}</p>
										{station.items.length === 0 && (
											<p className={styles.rsStationOffline}>OFFLINE</p>
										)}
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
