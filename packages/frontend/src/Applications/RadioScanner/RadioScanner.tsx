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
import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { useMediaStream } from "../../Providers/MediaStream/useMediaStream";
import styles from "./RadioScanner.module.scss";
import "./RadioScannerContext";
import { WaveformVisualizer } from "./WaveformVisualizer";

/** Seconds into the audio file that corresponds to the given wall-clock time. */
function calcSeekSeconds(item: MediaItem, clockMs: number): number {
	// Directus stores datetimes without a timezone suffix; force UTC so that
	// JavaScript does not misinterpret them as local time.
	const dateStr = /Z$|[+-]\d{2}:\d{2}$/.test(item.start_date)
		? item.start_date
		: item.start_date + "Z";
	const startMs = new Date(dateStr).getTime();
	const raw = (clockMs - startMs) / 1000 + item.jump;
	return Math.max(0, raw);
}

type RadioScannerProps = Record<string, never>;

export const RadioScanner: React.FC<RadioScannerProps> = () => {
	const appName = "Radio Scanner";
	const appId = "RadioScanner.app";
	const appIcon = ClassicyIcons.controlPanels.soundManager.app as string;

	const desktopEventDispatch = useAppManagerDispatch();
	const appState = useAppManager(
		(state) => state.System.Manager.Applications.apps[appId],
	);

	const { items } = useMediaStream({ format: ["mp3"], approved: true });
	const { dateTime, paused: clockPaused } = useClassicyDateTime();

	const [activeStation, setActiveStation] = useState<number>(0);
	const [hasInteracted, setHasInteracted] = useState<boolean>(false);
	const [scannerMode, setScannerMode] = useState<boolean>(
		(appState?.data?.scannerMode as boolean) ?? false,
	);
	const [selectedStations, setSelectedStations] = useState<number[]>(
		(appState?.data?.selectedStations as number[]) ?? [],
	);
	const [mutedStations, setMutedStations] = useState<number[]>(
		(appState?.data?.mutedStations as number[]) ?? [],
	);
	// Per-station version counter — incremented in onLoadedMetadata so only
	// the affected WaveformVisualizer remounts, not all of them.
	const [readyVersions, setReadyVersions] = useState<Map<number, number>>(
		new Map(),
	);

	const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());
	// Stable ref to mutedStations for use inside play().then() closures.
	const mutedStationsRef = useRef(mutedStations);
	mutedStationsRef.current = mutedStations;
	const prevDateTimeRef = useRef(dateTime);
	const dateTimeRef = useRef(dateTime);
	dateTimeRef.current = dateTime;
	const clockPausedRef = useRef(clockPaused);
	clockPausedRef.current = clockPaused;
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const dateTimeUpdatedAtRef = useRef<number>(Date.now());

	// Select the first station once items arrive.
	useEffect(() => {
		if (activeStation === 0 && items.length > 0) {
			setActiveStation(items[0].id);
		}
	}, [items, activeStation]);

	// Record the real-clock instant each time the Classicy dateTime is updated.
	// biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
	useEffect(() => {
		dateTimeUpdatedAtRef.current = Date.now();
	}, [dateTime]);

	// Periodic health check: ensure every player is playing and in sync.
	useEffect(() => {
		const healthId = setInterval(() => {
			const elapsedRealMs = Date.now() - dateTimeUpdatedAtRef.current;
			const nowMs = new Date(dateTimeRef.current).getTime() + elapsedRealMs;

			for (const item of itemsRef.current) {
				const el = audioRefs.current.get(item.id);
				if (!el) continue;

				if (!clockPausedRef.current && (el.paused || el.ended)) {
					el.play().catch(() => {});
				}

				const expected = calcSeekSeconds(item, nowMs);
				if (Math.abs(el.currentTime - expected) > 30) {
					el.currentTime = expected;
				}
			}
		}, 15_000);

		return () => clearInterval(healthId);
	}, []);

	// Seek all mounted players whenever the stored dateTime changes.
	useEffect(() => {
		const prevMs = new Date(prevDateTimeRef.current).getTime();
		const nowMs = new Date(dateTime).getTime();
		const delta = nowMs - prevMs;
		const isNaturalMinuteTick = delta > 0 && Math.abs(delta - 60_000) < 3_000;

		if (!isNaturalMinuteTick && prevMs !== nowMs) {
			for (const item of itemsRef.current) {
				const el = audioRefs.current.get(item.id);
				if (el) {
					el.currentTime = calcSeekSeconds(item, nowMs);
				}
			}
		}

		prevDateTimeRef.current = dateTime;
	}, [dateTime]);

	// Pause or resume all players when the system clock is paused/resumed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: itemsRef/dateTimeRef/audioRefs are stable refs
	useEffect(() => {
		const nowMs = new Date(dateTimeRef.current).getTime();
		for (const item of itemsRef.current) {
			const el = audioRefs.current.get(item.id);
			if (!el) continue;
			if (clockPaused) {
				el.pause();
				el.currentTime = calcSeekSeconds(item, nowMs);
			} else {
				el.play().catch(() => {});
			}
		}
	}, [clockPaused]);

	// Persist scanner layout and mute state to app settings on every change.
	useEffect(() => {
		desktopEventDispatch({
			type: "ClassicyAppRadioScannerSetState",
			scannerMode,
			selectedStations,
			mutedStations,
		});
	}, [scannerMode, selectedStations, mutedStations, desktopEventDispatch]);

	/** Seek the given item's audio element to the current clock position. */
	const seekToCurrentTime = (item: MediaItem) => {
		const el = audioRefs.current.get(item.id);
		if (!el) return;
		const elapsedRealMs = Date.now() - dateTimeUpdatedAtRef.current;
		const nowMs = new Date(dateTimeRef.current).getTime() + elapsedRealMs;
		el.currentTime = calcSeekSeconds(item, nowMs);
	};

	const toggleScanner = () => {
		setScannerMode((prev) => {
			const entering = !prev;
			setSelectedStations(entering && activeStation ? [activeStation] : []);
			setMutedStations([]);
			// Clicking Scan IS a user interaction — allow audio to play.
			if (entering) setHasInteracted(true);
			return entering;
		});
	};

	const toggleStationSelection = (id: number) => {
		setSelectedStations((prev) =>
			prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
		);
	};

	// effectivelyMuted reflects what the button currently shows, so the toggle
	// always moves in the opposite direction. el.volume is set immediately for
	// instant response; state update keeps the button icon in sync.
	const toggleStationMute = (id: number, effectivelyMuted: boolean) => {
		setHasInteracted(true);
		setMutedStations((prev) =>
			effectivelyMuted ? prev.filter((p) => p !== id) : [...prev, id],
		);
		const el = audioRefs.current.get(id);
		if (el) el.volume = effectivelyMuted ? 1 : 0;
	};

	const gridColumns = Math.ceil(Math.sqrt(Math.max(1, selectedStations.length)));

	const appMenu = [
		{
			id: "file",
			title: "File",
			menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
		},
	];

	const activeItem = items.find((i) => i.id === activeStation);

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
						{/* Waveform visualizer background — only shown in single-station mode */}
						{!scannerMode && activeItem && (
							<WaveformVisualizer
								key={`waveform-main-${activeStation}`}
								audioEl={audioRefs.current.get(activeStation) ?? null}
							/>
						)}

						{/* Single-station info display */}
						{!scannerMode && activeItem && (
							<div className={styles.rsDisplay}>
								<p className={styles.rsDisplaySource}>{activeItem.source}</p>
								<p className={styles.rsDisplayTitle}>{activeItem.title}</p>
								{activeItem.content && (
									<p className={styles.rsDisplayContent}>{activeItem.content}</p>
								)}
							</div>
						)}

						{/* Scanner mode: grid of active stations */}
						{scannerMode && selectedStations.length > 0 && (
							<div
								className={styles.rsGrid}
								style={{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }}
							>
								{selectedStations.map((id) => {
									const item = items.find((i) => i.id === id);
									if (!item) return null;
									const isMuted = mutedStations.includes(id);
									return (
										<div key={id} className={styles.rsGridStation}>
											<div className={styles.rsGridStationControls}>
												<button
													className={styles.rsGridControlBtn}
													type="button"
													onMouseUp={() => toggleStationMute(id, isMuted)}
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
													onMouseUp={() => toggleStationSelection(id)}
												>
													✕
												</button>
											</div>
											<p className={styles.rsGridStationSource}>{item.source}</p>
											<p className={styles.rsGridStationTitle}>{item.title}</p>
											<audio
												ref={(el) => {
													if (el) {
														// Start muted so the browser permits autoplay.
														// onCanPlay switches to volume-based control after
														// play() resolves so the Web Audio API can read samples.
														el.muted = true;
														audioRefs.current.set(id, el);
													} else {
														audioRefs.current.delete(id);
													}
												}}
												src={item.url}
												crossOrigin="anonymous"
												style={{ display: "none" }}
												onLoadedMetadata={() => {
													// Seek once when metadata loads. Using onLoadedMetadata
													// (fires once per load) instead of onCanPlay avoids a
													// seek → canplay → seek loop.
													seekToCurrentTime(item);
													setReadyVersions((prev) => {
														const next = new Map(prev);
														next.set(id, (prev.get(id) ?? 0) + 1);
														return next;
													});
												}}
												onCanPlay={(e) => {
													const el = e.currentTarget;
													if (!clockPausedRef.current) {
														el.play()
															.then(() => {
																// Now playing: drop the muted flag and use
																// volume instead so the AnalyserNode gets data.
																el.muted = false;
																el.volume =
																	mutedStationsRef.current.includes(id) ? 0 : 1;
															})
															.catch(() => {});
													}
												}}
											/>
											{/* Per-station key: only this visualizer remounts when its
											    audio element becomes ready; other stations unaffected. */}
											<WaveformVisualizer
												key={`waveform-${id}-${readyVersions.get(id) ?? 0}`}
												audioEl={audioRefs.current.get(id) ?? null}
											/>
										</div>
									);
								})}
							</div>
						)}
					</div>

					{/* Bottom row: control panel + station strip */}
					<div className={styles.rsBottomRow}>
						<div className={styles.rsControlPanel}>
							<ClassicyButton onClickFunc={toggleScanner} depressed={scannerMode}>
								Scan
							</ClassicyButton>
						</div>
						<div className={styles.rsStationStrip}>
							{items.slice(0, 12).map((item) => {
								const isActive = !scannerMode && item.id === activeStation;
								const isSelected = selectedStations.includes(item.id);
								// Selected stations in scanner mode render their player in the grid
								const renderPlayer = !scannerMode || !isSelected;

								return (
									<button
										key={item.id}
										className={[
											styles.rsStation,
											isActive ? styles.rsStationActive : "",
											isSelected ? styles.rsStationSelected : "",
										]
											.filter(Boolean)
											.join(" ")}
										onClick={() => {
											if (scannerMode) {
												toggleStationSelection(item.id);
											} else {
												setActiveStation(item.id);
											}
											setHasInteracted(true);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												if (scannerMode) {
													toggleStationSelection(item.id);
												} else {
													setActiveStation(item.id);
												}
												setHasInteracted(true);
											}
										}}
										type="button"
									>
										<p className={styles.rsStationSource}>{item.source}</p>
										{renderPlayer && (
											<audio
												ref={(el) => {
													if (el) audioRefs.current.set(item.id, el);
													else audioRefs.current.delete(item.id);
												}}
												src={item.url}
												crossOrigin="anonymous"
												style={{ display: "none" }}
												muted={!(isActive && hasInteracted)}
												onCanPlay={(e) => {
													const el = e.currentTarget;
													seekToCurrentTime(item);
													if (!clockPausedRef.current) el.play().catch(() => {});
												}}
											/>
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
