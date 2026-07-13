import { useEffect, useRef, useState } from "react";

// Static Wasabi JSON manifest per station, published by the weather-recon
// almanac flow (packages/tools/weather-recon/weather_recon/flow_almanac.py).
// Not on the websocket wire at all — same "fetch on demand" pattern as
// FlightTracker's useFlightTrack.ts for flight_tracks.
const ALMANAC_BASE = "https://files.911realtime.org/weather/almanac/";

// One calendar day's normals/records. All fields are nullable — record ties
// go to the latest year, but a gap station's GHCN neighbor may still lack
// enough history for a given stat, in which case the flow writes a real
// `null`, not an omitted key.
export interface AlmanacDay {
	record_high_c: number | null;
	record_high_year: number | null;
	record_low_c: number | null;
	record_low_year: number | null;
	normal_high_c: number | null;
	normal_low_c: number | null;
	record_precip_mm: number | null;
	record_precip_year: number | null;
}

// Keys are always exactly "09-09".."09-12" (the anachronism-cutoff window
// the flow computes) — never a full year-qualified date.
export interface AlmanacFile {
	station_id: string;
	ghcn_id: string;
	cutoff: string;
	run_id: string;
	days: Record<string, AlmanacDay>;
}

export function almanacUrl(stationId: string): string {
	return `${ALMANAC_BASE}${stationId}.json`;
}

// Fetch a station's almanac file, cached by station_id (the file is
// immutable/static). Aborts an in-flight request when the station changes
// or the component unmounts. A miss or error surfaces as `error` with a
// null almanac, never a throw — the panel degrades gracefully.
export function useAlmanac(stationId: string | null): {
	almanac: AlmanacFile | null;
	loading: boolean;
	error: string | null;
} {
	const [almanac, setAlmanac] = useState<AlmanacFile | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cache = useRef<Map<string, AlmanacFile>>(new Map());

	useEffect(() => {
		if (!stationId) {
			setAlmanac(null);
			setError(null);
			setLoading(false);
			return;
		}
		const cached = cache.current.get(stationId);
		if (cached) {
			setAlmanac(cached);
			setError(null);
			setLoading(false);
			return;
		}

		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetch(almanacUrl(stationId), { signal: controller.signal })
			.then(async (res) => {
				if (controller.signal.aborted) return;
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = (await res.json()) as AlmanacFile;
				cache.current.set(stationId, json);
				setAlmanac(json);
			})
			.catch((err: unknown) => {
				if (controller.signal.aborted) return;
				// Keep the raw fetch error out of the UI; console only.
				console.warn("almanac fetch failed:", err);
				setAlmanac(null);
				setError("Almanac unavailable");
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});

		return () => controller.abort();
	}, [stationId]);

	return { almanac, loading, error };
}
