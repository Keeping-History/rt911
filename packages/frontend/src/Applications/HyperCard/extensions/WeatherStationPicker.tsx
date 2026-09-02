/**
 * The HyperCard inspector's picker for directusWeatherStation's `station`
 * field (issue #560) — checks off the station(s) to embed from whatever's
 * *currently* reporting on the live weather channel (resolved open question:
 * live data only, not the full static station list), the same
 * `MediaStreamContext` reads `DirectusWeatherPart.tsx` itself uses. `station`
 * stores an array, so this picker always runs in multi-select mode.
 */
import { useContext, useEffect, useMemo } from "react";
import { MediaStreamContext } from "../../../Providers/MediaStream/MediaStreamContext";
import stationsRaw from "../../Weather/stations.json";
import type { WeatherStation } from "../../Weather/WeatherMap";
import { filterRowsByQuery, HyperCardOptionPickerField, type HyperCardItemPickerRow } from "./HyperCardItemPicker";

const STATIONS = stationsRaw as WeatherStation[];
const PICKER_APP_ID = "hypercard-weather-station-picker";

export function WeatherStationPicker({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
	// Subscribing here (ref-counted, same as the part itself) means the live
	// station list is populated for authoring even if no other app currently
	// has the weather channel open.
	const { weatherObservations, subscribeWeather, unsubscribeWeather } = useContext(MediaStreamContext);
	useEffect(() => {
		subscribeWeather(PICKER_APP_ID);
		return () => unsubscribeWeather(PICKER_APP_ID);
	}, [subscribeWeather, unsubscribeWeather]);

	const rows = useMemo<HyperCardItemPickerRow[]>(() => {
		return Object.keys(weatherObservations)
			.map((id) => STATIONS.find((s) => s.station_id === id))
			.filter((s): s is WeatherStation => !!s)
			.map((s) => ({ id: s.station_id, label: `${s.station_id} — ${s.name}` }));
	}, [weatherObservations]);

	const fetchItems = useMemo(() => (query: string) => filterRowsByQuery(rows, query), [rows]);

	return (
		<HyperCardOptionPickerField
			label="Weather Stations"
			value={value}
			onChange={onChange}
			pickerKey="weather_station"
			title="Choose Weather Stations"
			fetchItems={fetchItems}
			searchPlaceholder="Search station id or name"
			emptyMessage="No stations are currently reporting."
		/>
	);
}
