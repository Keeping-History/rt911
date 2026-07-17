import type { HyperCardPartProps } from "classicy";
import { useClassicyDateTime } from "classicy";
import { useContext, useEffect, useMemo } from "react";
import { MediaStreamContext } from "../../../Providers/MediaStream/MediaStreamContext";
import stationsRaw from "../../Weather/stations.json";
import { ALMANAC_DAYS, useAlmanac } from "../../Weather/useAlmanac";
import type { WeatherStation } from "../../Weather/WeatherMap";
import { WeatherStationPanel } from "../../Weather/WeatherStationPanel";
import "./DirectusWeatherPart.css";

/**
 * `directusWeatherStation` HyperCard part — embeds one weather station's live
 * readout (conditions, forecast, almanac) using the same `WeatherStationPanel`
 * the Weather app renders. Reads the shared virtual clock and the streamed
 * weather channel (via `MediaStreamContext`), so it stays in lockstep with the
 * desktop like every other app.
 *
 *   { "id": "wx", "type": "directusWeatherStation", "rect": [12, 12, 260, 300],
 *     "options": { "station": "KJFK" } }
 *
 * `station` is an ICAO station id from the app's static station list; it
 * resolves through the stack expression engine (so it may track a variable).
 */

const STATIONS = stationsRaw as WeatherStation[];
const DEFAULT_STATION_ID = "KJFK";

export const DirectusWeatherPart = ({ options, value, resolve, partId, stackId }: HyperCardPartProps) => {
	const stationId = useMemo(() => {
		const raw = (typeof options.station === "string" || typeof options.station === "number"
			? options.station
			: undefined) ?? value;
		const resolved = raw ? resolve(String(raw)).trim() : "";
		return resolved || DEFAULT_STATION_ID;
	}, [options.station, value, resolve]);

	const station = useMemo(
		() => STATIONS.find((s) => s.station_id === stationId) ?? null,
		[stationId],
	);

	const {
		weatherObservations,
		weatherForecastByZone,
		subscribeWeather,
		unsubscribeWeather,
		requestWeatherForecast,
	} = useContext(MediaStreamContext);

	// Ref-counted subscription to the shared weather channel (one appId per
	// embed), released on unmount — the same pattern the Weather app uses.
	const appId = `hc-weather-${stackId}-${partId}`;
	useEffect(() => {
		subscribeWeather(appId);
		return () => unsubscribeWeather(appId);
	}, [subscribeWeather, unsubscribeWeather, appId]);

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
};
