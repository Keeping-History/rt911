import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	useAppManager,
} from "classicy";
import { type FC, useContext, useEffect, useMemo, useState } from "react";
import {
	MediaStreamContext,
	type FlightPosition,
} from "../../Providers/MediaStream/MediaStreamContext";
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

	// If the selected flight leaves the airborne set (e.g. after a seek), keep the
	// last-known position object; clear selection when the set empties on seek.
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
								onSelectFlight={onSelectFlight}
								onClearSelection={() => setSelected(null)}
							/>
						</div>
						<FlightDetailPanel
							selected={selected}
							track={track}
							loading={loading}
							error={error}
						/>
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
