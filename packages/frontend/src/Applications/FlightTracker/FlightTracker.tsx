import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	useAppManager,
	useClassicyDateTime,
} from "classicy";
import { type FC, useContext, useEffect, useMemo, useState } from "react";
import {
	MediaStreamContext,
	type FlightPosition,
} from "../../Providers/MediaStream/MediaStreamContext";
import { virtualUtcMs } from "../../Providers/MediaStream/virtualClock";
import { FlightDetailPanel } from "./FlightDetailPanel";
import { FlightMap } from "./FlightMap";
import { type TrackSelection, useFlightTrack } from "./useFlightTrack";
import styles from "./FlightTracker.module.scss";
import type { Feature } from "geojson";

const BASEMAP_URL =
	(import.meta.env.VITE_FLIGHT_BASEMAP_URL as string | undefined) ??
	"https://files.911realtime.org/maps/na-basemap.pmtiles";

export const FlightTracker: FC = () => {
	const appId = "FlightTracker.app";
	const appName = "Flight Tracker";
	const appIcon = ClassicyIcons.controlPanels.location.app as string;
	const appMenu = useMemo(
		() => [
			{
				id: "file",
				title: "File",
				menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
			},
		],
		[appIcon],
	);

	const isRunning = useAppManager(
		(s) => appId in (s.System.Manager.Applications.apps ?? {}),
	);

	const { flightPositions, subscribeFlights, unsubscribeFlights, connected } =
		useContext(MediaStreamContext);

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
						/>
						</div>
					</div>
					<div className={styles.statusBar}>
						<span>
							<span style={{ color: connected ? "green" : "red" }}>&bull;</span>{" "}
							{connected ? "Live" : "Disconnected"}
						</span>
						<span>{flightPositions.length} aircraft aloft</span>
					</div>
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};
