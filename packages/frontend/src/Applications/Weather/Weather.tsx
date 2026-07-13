import {
	ClassicyApp,
	ClassicyButton,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyPopUpMenu,
	ClassicySlider,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import { type FC, useCallback, useContext, useEffect, useMemo, useState } from "react";
import appIconPng from "./app.png";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import { BASEMAP_URLS, type BasemapStyleId } from "../../lib/basemap/basemapStyles";
import { useAlmanac } from "./useAlmanac";
import type { RadarIndex } from "./weatherRadar";
import { cToF, degToCompass, hpaToInHg, kmToMiles, ktToMph } from "./weatherUnits";
import { WeatherMap, type WeatherStation } from "./WeatherMap";
import stationsRaw from "./stations.json";
import styles from "./Weather.module.scss";
import { formatPlayhead, type LoopClock, playheadAt } from "../../lib/loopClock";
// Importing this module also registers the ClassicyAppWeather reducer.
import {
	readWeatherLoopSettings,
	readWeatherMapSettings,
	WEATHER_LOOP_SPEEDS,
	WEATHER_SPEED_LABELS,
	weatherSetLoopSettings,
	weatherSetMapSettings,
	type WeatherLoopSpeed,
	type WeatherLoopWindowHours,
} from "./weatherSettings";

// Static Wasabi manifest, fetched once on mount (not on the websocket wire).
const RADAR_INDEX_URL = "https://files.911realtime.org/weather/radar/index.json";

const STATIONS = stationsRaw as WeatherStation[];

const DEFAULT_STATION_ID = "KJFK";

// Almanac data exists only for these four calendar days (the weather-recon
// almanac flow's anachronism-cutoff window) — outside this range the block
// is hidden entirely rather than showing an empty/misleading section.
const ALMANAC_DAYS = new Set(["09-09", "09-10", "09-11", "09-12"]);

// "8:55 AM"-style local time for a UTC instant, rendered in the *station's*
// own timezone (its `tz` field) — this is "what does the station's local
// clock read", not the app's display-timezone menu-bar clock.
function formatStationTime(iso: string, tz: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	}).format(new Date(iso));
}

// METAR visibility reports cap at 10sm; kmToMiles itself is uncapped, so the
// display cap is applied here, at render time, not in the unit conversion.
function formatVisibility(km: number): string {
	const mi = kmToMiles(km);
	return mi >= 10 ? "10 mi" : `${mi} mi`;
}

// Absent wind speed means no reading at all ("—"); direction and gusts are
// each optional add-ons layered onto a present speed.
function formatWind(
	dirDeg: number | undefined,
	speedKt: number | undefined,
	gustKt: number | undefined,
): string {
	if (speedKt === undefined) return "—";
	const dir = dirDeg !== undefined ? `${degToCompass(dirDeg)} ` : "";
	const gust = gustKt !== undefined ? ` (gusts ${ktToMph(gustKt)} mph)` : "";
	return `${dir}${ktToMph(speedKt)} mph${gust}`;
}

// This app's own icon, registered into the shared registry at
// ClassicyIcons.applications.weather.app. registerClassicyIcons assigns
// shallowly, so the existing applications namespace is spread in to keep
// classicy's bundled app icons intact (same gotcha as FlightTracker.tsx).
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		weather: { app: appIconPng },
	},
});

export const Weather: FC = () => {
	const appId = "Weather.app";
	const appName = "Weather";
	const appIcon = ICONS.applications.weather.app;

	const {
		weatherObservations,
		weatherForecastByZone,
		subscribeWeather,
		unsubscribeWeather,
		requestWeatherForecast,
	} = useContext(MediaStreamContext);

	// Read-only: this app never mutates the clock (only TimeMachine does).
	// dateTime is already true UTC (TV.tsx:222 precedent) — no tz stripping
	// needed for either the radar frame lookup or the almanac day key.
	const { dateTime, tzOffset } = useClassicyDateTime({ tick: true });
	const utcMs = new Date(dateTime).getTime();
	// MM-DD component of the virtual UTC date — the almanac window key.
	const currentMMDD = dateTime.slice(5, 10);

	// Loop-mode preferences persist in Classicy app data (View menu + strip
	// popups write them); ephemeral playback state (clock anchors, scrubbing,
	// paused, playhead) stays local — the desktop clock keeps running live and
	// is never written from here. Mirrors FlightTracker's loop wiring.
	const desktopEventDispatch = useAppManagerDispatch();
	const appData = useAppManager(
		(s) =>
			s.System.Manager.Applications.apps[appId]?.data as
				| Record<string, unknown>
				| undefined,
	);
	const loopSettings = useMemo(() => readWeatherLoopSettings(appData), [appData]);
	const loopEnabled = loopSettings.enabled;
	const windowMs = loopSettings.windowHours * 3_600_000;

	// Map appearance (View menu's style items + Dark Map toggle); independent
	// of loopSettings above — see weatherSettings.ts.
	const mapSettings = useMemo(() => readWeatherMapSettings(appData), [appData]);

	const setMapStyle = useCallback(
		(mapStyle: BasemapStyleId) =>
			desktopEventDispatch(weatherSetMapSettings({ ...mapSettings, mapStyle })),
		[mapSettings, desktopEventDispatch],
	);
	const toggleDarkMap = useCallback(
		() =>
			desktopEventDispatch(
				weatherSetMapSettings({ ...mapSettings, darkMap: !mapSettings.darkMap }),
			),
		[mapSettings, desktopEventDispatch],
	);

	// Anchored at the top of the loop on mount (same as toggleLoop), so a
	// restored session starts at the window head, not a wrapped offset.
	const [loopClock, setLoopClock] = useState<LoopClock>(() => ({
		anchorVirtual: utcMs - windowMs,
		anchorWall: performance.now(),
		speed: loopSettings.speed,
		scrubbing: false,
		paused: false,
	}));
	const [playheadMs, setPlayheadMs] = useState(0);

	const toggleLoop = useCallback(() => {
		if (!loopEnabled) {
			// Start each session at the top of the loop, at the saved speed.
			setLoopClock({
				anchorVirtual: utcMs - windowMs,
				anchorWall: performance.now(),
				speed: loopSettings.speed,
				scrubbing: false,
				paused: false,
			});
		}
		desktopEventDispatch(
			weatherSetLoopSettings({ ...loopSettings, enabled: !loopEnabled }),
		);
	}, [loopEnabled, utcMs, windowMs, loopSettings, desktopEventDispatch]);

	// Slider drag: freeze at the dragged instant. Release: resume from there.
	const scrubTo = useCallback(
		(offsetSec: number, scrubbing: boolean) => {
			setLoopClock((c) => ({
				...c,
				anchorVirtual: utcMs - windowMs + offsetSec * 1000,
				anchorWall: performance.now(),
				scrubbing,
			}));
		},
		[utcMs, windowMs],
	);

	// Re-anchor at the current playhead so a speed change never jumps the
	// radar, and persist the new speed as a preference.
	const setLoopSpeed = useCallback(
		(speed: WeatherLoopSpeed) => {
			setLoopClock((c) => ({
				...c,
				speed,
				anchorVirtual: playheadMs,
				anchorWall: performance.now(),
			}));
			desktopEventDispatch(weatherSetLoopSettings({ ...loopSettings, speed }));
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

	// Playhead for the slider, the time label, and the radar frame lookup.
	// 4 Hz is plenty: the only consumer that matters buckets to 5-min frames
	// (no rAF glide layer needed, unlike FlightTracker's ghost pins).
	useEffect(() => {
		if (!loopEnabled) return;
		const update = () => {
			setPlayheadMs(playheadAt(loopClock, performance.now(), utcMs - windowMs, utcMs));
		};
		update();
		const id = setInterval(update, 250);
		return () => clearInterval(id);
	}, [loopEnabled, loopClock, utcMs, windowMs]);

	// Ref-counted by appId server-side. Subscribe on mount, mirror
	// RadioScanner: all desktop apps are statically mounted at boot, and the
	// isRunning gate other apps use is map-membership that also flips true at
	// boot — there is no real closed-state gate in this architecture.
	useEffect(() => {
		subscribeWeather(appId);
		return () => unsubscribeWeather(appId);
	}, [subscribeWeather, unsubscribeWeather, appId]);

	const [radarIndex, setRadarIndex] = useState<RadarIndex | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		fetch(RADAR_INDEX_URL, { signal: controller.signal })
			.then(async (res) => {
				if (controller.signal.aborted) return;
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				setRadarIndex((await res.json()) as RadarIndex);
			})
			.catch((err: unknown) => {
				if (controller.signal.aborted) return;
				console.warn("weather radar index fetch failed:", err);
			});
		return () => controller.abort();
	}, []);

	// Seeded via component state, not defaultState — no cross-session
	// persistence for the selection in v1.
	const [selectedStationId, setSelectedStationId] = useState(DEFAULT_STATION_ID);
	const station = useMemo(
		() => STATIONS.find((s) => s.station_id === selectedStationId) ?? null,
		[selectedStationId],
	);

	// One request per zone: the provider dedupes/echoes by an internal id, so
	// re-firing on every render would be wasteful but not wrong — this effect
	// only re-fires when the selected station's zone actually changes.
	useEffect(() => {
		if (!station?.nws_zone) return;
		requestWeatherForecast(station.nws_zone);
	}, [station?.nws_zone, requestWeatherForecast]);

	const { almanac } = useAlmanac(station?.station_id ?? null);

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
					id: "weather-style-classic-menu",
					title: `${mapSettings.mapStyle === "classic" ? "✓ " : ""}Classic Map`,
					onClickFunc: () => setMapStyle("classic"),
				},
				{
					id: "weather-style-radar-menu",
					title: `${mapSettings.mapStyle === "radar" ? "✓ " : ""}Radar Scope`,
					onClickFunc: () => setMapStyle("radar"),
				},
				{
					id: "weather-style-satellite-menu",
					title: `${mapSettings.mapStyle === "satellite" ? "✓ " : ""}Satellite`,
					onClickFunc: () => setMapStyle("satellite"),
				},
				{
					id: "weather-darkmap-menu",
					title: `${mapSettings.darkMap ? "✓ " : ""}Dark Map`,
					onClickFunc: toggleDarkMap,
				},
				{
					// ClassicyMenuItem has no checked prop — the ✓ lives in the title.
					id: "weather-loop-menu",
					title: `${loopEnabled ? "✓ " : ""}Loop Playback`,
					onClickFunc: toggleLoop,
				},
			],
		},
	];

	const obs = station ? weatherObservations[station.station_id] : undefined;
	// nws_zone empty (null) stations (CA/MX/KHSV) never fire a request, so
	// this stays permanently undefined for them — distinct from a genuine
	// zone's undefined (pending) vs explicit null (confirmed no product).
	const forecastEntry = station?.nws_zone
		? weatherForecastByZone[station.nws_zone]
		: undefined;

	const showAlmanac = ALMANAC_DAYS.has(currentMMDD);
	const almanacDay = almanac?.days[currentMMDD] ?? null;

	return (
		<ClassicyApp id={appId} name={appName} icon={appIcon} defaultWindow="weather-main">
			<ClassicyWindow
				id="weather-main"
				title="Weather"
				icon={appIcon}
				appId={appId}
				initialSize={[760, 520]}
				initialPosition={["center", "center"]}
				appMenu={appMenu}
				scrollable={false}
				resizable
				growable
			>
				<div className={styles.outer}>
					<div className={styles.root}>
						<div className={styles.map}>
							<WeatherMap
								stations={STATIONS}
								observations={weatherObservations}
								selectedStation={selectedStationId}
								onSelectStation={setSelectedStationId}
								radarIndex={radarIndex}
								utcMs={loopEnabled ? playheadMs : utcMs}
								mapStyle={mapSettings.mapStyle}
								darkMap={mapSettings.darkMap}
								basemapUrls={BASEMAP_URLS}
							/>
						</div>
						<div className={styles.panel}>
							{!station ? (
								<p className={styles.panelEmpty}>Select a station.</p>
							) : (
								<>
									<div className={styles.stationHeader}>
										<span className={styles.stationName}>{station.name}</span>
										<span className={styles.stationAsOf}>
											{obs
												? `as of ${formatStationTime(obs.start_date, station.tz)}`
												: "no recent observation"}
										</span>
									</div>

									<ClassicyControlGroup label="Conditions">
										<span className={styles.tempBig}>
											{obs?.temp_c !== undefined ? `${cToF(obs.temp_c)}°F` : "—"}
										</span>
										<div className={styles.skyLine}>
											{[obs?.sky_condition, obs?.present_weather]
												.filter(Boolean)
												.join(" ") || "—"}
										</div>
										<dl className={styles.fields}>
											<dt>Wind</dt>
											<dd>
												{formatWind(obs?.wind_dir_deg, obs?.wind_speed_kt, obs?.gust_kt)}
											</dd>
											<dt>Visibility</dt>
											<dd>
												{obs?.visibility_km !== undefined
													? formatVisibility(obs.visibility_km)
													: "—"}
											</dd>
											<dt>Pressure</dt>
											<dd>
												{obs?.pressure_hpa !== undefined
													? `${hpaToInHg(obs.pressure_hpa)} inHg`
													: "—"}
											</dd>
											<dt>Dewpoint</dt>
											<dd>
												{obs?.dewpoint_c !== undefined ? `${cToF(obs.dewpoint_c)}°F` : "—"}
											</dd>
										</dl>
									</ClassicyControlGroup>

									<div className={styles.section}>
										<div className={styles.sectionTitle}>Forecast</div>
										{!station.nws_zone ? (
											<p className={styles.note}>
												No archived forecast for this station.
											</p>
										) : forecastEntry === undefined ? (
											<p className={styles.note}>retrieving…</p>
										) : forecastEntry === null ? (
											<p className={styles.note}>No forecast product at this hour.</p>
										) : (
											<pre className={styles.forecastText}>{forecastEntry.raw_text}</pre>
										)}
									</div>

									{showAlmanac && (
										<div className={styles.section}>
											<div className={styles.sectionTitle}>Almanac</div>
											{almanacDay ? (
												<div className={styles.almanacDay}>
													<span>
														Normal high/low:{" "}
														{almanacDay.normal_high_c !== null
															? `${cToF(almanacDay.normal_high_c)}°F`
															: "—"}
														{" / "}
														{almanacDay.normal_low_c !== null
															? `${cToF(almanacDay.normal_low_c)}°F`
															: "—"}
													</span>
													<span>
														Record high:{" "}
														{almanacDay.record_high_c !== null
															? `${cToF(almanacDay.record_high_c)}°F (${almanacDay.record_high_year})`
															: "—"}
													</span>
													<span>
														Record low:{" "}
														{almanacDay.record_low_c !== null
															? `${cToF(almanacDay.record_low_c)}°F (${almanacDay.record_low_year})`
															: "—"}
													</span>
												</div>
											) : (
												<p className={styles.note}>No almanac data.</p>
											)}
										</div>
									)}
								</>
							)}
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
								id="weather_loop_window"
								label="Time"
								labelPosition="left"
								labelSize="small"
								size="small"
								options={[
									{ value: "1", label: "1 hr" },
									{ value: "3", label: "3 hr" },
									{ value: "6", label: "6 hr" },
									{ value: "12", label: "12 hr" },
								]}
								selected={String(loopSettings.windowHours)}
								onChangeFunc={(e) =>
									desktopEventDispatch(
										weatherSetLoopSettings({
											...loopSettings,
											windowHours: Number(e.target.value) as WeatherLoopWindowHours,
										}),
									)
								}
							/>
							<ClassicyPopUpMenu
								id="weather_loop_speed"
								label="Speed"
								labelPosition="left"
								labelSize="small"
								size="small"
								options={WEATHER_LOOP_SPEEDS.map((s) => ({
									value: String(s),
									label: WEATHER_SPEED_LABELS[s],
								}))}
								selected={String(loopClock.speed)}
								onChangeFunc={(e) =>
									setLoopSpeed(Number(e.target.value) as WeatherLoopSpeed)
								}
							/>
							<div className={styles.loopSlider}>
								<ClassicySlider
									id="weather_loop_scrub"
									value={Math.round(
										Math.min(
											Math.max((playheadMs - (utcMs - windowMs)) / 1000, 0),
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
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};
