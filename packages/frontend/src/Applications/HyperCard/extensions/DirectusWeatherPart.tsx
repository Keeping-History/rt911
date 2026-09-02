import type { HyperCardPartProps } from "classicy";
import { useClassicyDateTime } from "classicy";
import { useContext, useEffect, useMemo } from "react";
import { MediaStreamContext } from "../../../Providers/MediaStream/MediaStreamContext";
import stationsRaw from "../../Weather/stations.json";
import { ALMANAC_DAYS, useAlmanac } from "../../Weather/useAlmanac";
import type { WeatherStation } from "../../Weather/WeatherMap";
import { WeatherStationPanel } from "../../Weather/WeatherStationPanel";
import { HyperCardPartGrid } from "./HyperCardPartGrid";
import { resolveItemIds } from "./useDirectusItem";
import "./DirectusWeatherPart.css";

/**
 * `directusWeatherStation` HyperCard part — embeds one or more weather
 * stations' live readouts (conditions, forecast, almanac) using the same
 * `WeatherStationPanel` the Weather app renders. Reads the shared virtual
 * clock and the streamed weather channel (via `MediaStreamContext`), so it
 * stays in lockstep with the desktop like every other app.
 *
 *   { "id": "wx", "type": "directusWeatherStation", "rect": [12, 12, 260, 300],
 *     "options": { "station": ["KJFK"] } }
 *
 * `station` is an array of ICAO station ids from the app's static station
 * list (issue #560's `WeatherStationPicker` always writes one), but a bare
 * scalar/variable id is still accepted for a part authored before that
 * change; each entry resolves through the stack expression engine (so it may
 * track a variable). No usable id falls back to a single default station, as
 * before. Two or more ids lay out as a `DirectusMultiviewPart`-style grid of
 * station panels.
 */

const STATIONS = stationsRaw as WeatherStation[];
const DEFAULT_STATION_ID = "KJFK";

/** One station's panel — split out so `DirectusWeatherPart` can render several, each with its own almanac/forecast lookups. */
function WeatherStationTile({ stationId }: { stationId: string }) {
	const station = useMemo(() => STATIONS.find((s) => s.station_id === stationId) ?? null, [stationId]);
	const { weatherObservations, weatherForecastByZone, requestWeatherForecast } = useContext(MediaStreamContext);

	useEffect(() => {
		if (station?.nws_zone) requestWeatherForecast(station.nws_zone);
	}, [station?.nws_zone, requestWeatherForecast]);

	// Read-only clock; `dateTime` is already true UTC, so the almanac day key is
	// just its MM-DD slice (same as Weather.tsx).
	const { dateTime } = useClassicyDateTime({ tick: true });
	const currentMMDD = dateTime.slice(5, 10);

	const { almanac } = useAlmanac(station?.station_id ?? null);
	const obs = station ? weatherObservations[station.station_id] : undefined;
	const forecastEntry = station?.nws_zone ? weatherForecastByZone[station.nws_zone] : undefined;

	return (
		<div className="classicyHyperCardWeather">
			<WeatherStationPanel
				station={station}
				obs={obs}
				forecastEntry={forecastEntry}
				almanacDay={almanac?.days[currentMMDD] ?? null}
				showAlmanac={ALMANAC_DAYS.has(currentMMDD)}
			/>
		</div>
	);
}

export const DirectusWeatherPart = ({ options, value, resolve, partId, stackId }: HyperCardPartProps) => {
	const stationIds = useMemo(() => {
		const ids = resolveItemIds(options.station, value, resolve);
		return ids.length > 0 ? ids : [DEFAULT_STATION_ID];
	}, [options.station, value, resolve]);

	// Ref-counted subscription to the shared weather channel (one appId per
	// embed, regardless of how many stations it shows), released on unmount —
	// the same pattern the Weather app uses.
	const { subscribeWeather, unsubscribeWeather } = useContext(MediaStreamContext);
	const appId = `hc-weather-${stackId}-${partId}`;
	useEffect(() => {
		subscribeWeather(appId);
		return () => unsubscribeWeather(appId);
	}, [subscribeWeather, unsubscribeWeather, appId]);

	if (stationIds.length === 1) {
		return <WeatherStationTile stationId={stationIds[0]} />;
	}

	return (
		<HyperCardPartGrid
			items={stationIds}
			getKey={(id, i) => `${id}-${i}`}
			renderItem={(id) => <WeatherStationTile stationId={id} />}
		/>
	);
};
