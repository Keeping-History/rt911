import { ClassicyControlGroup } from "classicy";
import type { FC } from "react";
import type {
	WeatherForecast,
	WeatherObservation,
} from "../../Providers/MediaStream/MediaStreamContext";
import type { AlmanacDay } from "./useAlmanac";
import { cToF, degToCompass, hpaToInHg, kmToMiles, ktToMph } from "./weatherUnits";
import type { WeatherStation } from "./WeatherMap";
import styles from "./Weather.module.scss";

// "8:55 AM"-style local time for a UTC instant, rendered in the *station's* own
// timezone (its `tz` field) — "what the station's local clock reads", not the
// app's display-timezone menu-bar clock.
function formatStationTime(iso: string, tz: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	}).format(new Date(iso));
}

// METAR visibility reports cap at 10sm; kmToMiles is uncapped, so the display
// cap is applied here at render time, not in the unit conversion.
function formatVisibility(km: number): string {
	const mi = kmToMiles(km);
	return mi >= 10 ? "10 mi" : `${mi} mi`;
}

// Absent wind speed means no reading at all ("—"); direction and gusts are each
// optional add-ons layered onto a present speed.
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

export interface WeatherStationPanelProps {
	station: WeatherStation | null;
	obs: WeatherObservation | undefined;
	/** undefined = pending, null = confirmed no product, else the forecast. */
	forecastEntry: WeatherForecast | null | undefined;
	almanacDay: AlmanacDay | null;
	/** Whether the current virtual day falls inside the almanac window. */
	showAlmanac: boolean;
}

/**
 * The station readout — conditions, forecast, almanac — for one weather
 * station. Extracted from Weather.tsx so both the Weather app and the
 * `directusWeatherStation` HyperCard embed render the identical panel.
 */
export const WeatherStationPanel: FC<WeatherStationPanelProps> = ({
	station,
	obs,
	forecastEntry,
	almanacDay,
	showAlmanac,
}) => {
	if (!station) {
		return <p className={styles.panelEmpty}>Select a station.</p>;
	}
	return (
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
					{[obs?.sky_condition, obs?.present_weather].filter(Boolean).join(" ") || "—"}
				</div>
				<dl className={styles.fields}>
					<dt>Wind</dt>
					<dd>{formatWind(obs?.wind_dir_deg, obs?.wind_speed_kt, obs?.gust_kt)}</dd>
					<dt>Visibility</dt>
					<dd>
						{obs?.visibility_km !== undefined ? formatVisibility(obs.visibility_km) : "—"}
					</dd>
					<dt>Pressure</dt>
					<dd>
						{obs?.pressure_hpa !== undefined ? `${hpaToInHg(obs.pressure_hpa)} inHg` : "—"}
					</dd>
					<dt>Dewpoint</dt>
					<dd>{obs?.dewpoint_c !== undefined ? `${cToF(obs.dewpoint_c)}°F` : "—"}</dd>
				</dl>
			</ClassicyControlGroup>

			<ClassicyControlGroup label="Forecast">
				{!station.nws_zone ? (
					<p className={styles.note}>No archived forecast for this station.</p>
				) : forecastEntry === undefined ? (
					<p className={styles.note}>retrieving…</p>
				) : forecastEntry === null ? (
					<p className={styles.note}>No forecast product at this hour.</p>
				) : (
					<pre className={styles.forecastText}>{forecastEntry.raw_text}</pre>
				)}
			</ClassicyControlGroup>

			{showAlmanac && (
				<ClassicyControlGroup label="Almanac">
					{almanacDay ? (
						<div className={styles.almanacDay}>
							<span>
								Normal high/low:{" "}
								{almanacDay.normal_high_c !== null ? `${cToF(almanacDay.normal_high_c)}°F` : "—"}
								{" / "}
								{almanacDay.normal_low_c !== null ? `${cToF(almanacDay.normal_low_c)}°F` : "—"}
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
				</ClassicyControlGroup>
			)}
		</>
	);
};
