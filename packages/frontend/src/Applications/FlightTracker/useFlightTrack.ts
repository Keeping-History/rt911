import { useEffect, useRef, useState } from "react";

// Directus REST base, read anonymously — same static-reference-data path the
// Time Machine bookmarks use (see TimeMachine/useBookmarks.ts). Track geometry
// is static per flight, so it is fetched over REST, not streamed.
const DIRECTUS_URL =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ??
	"https://api-beta.911realtime.org";

// Rich curated metadata, present only on the four notable flights (AA11,
// UA175, AA77, UA93). Every key is optional — the panel renders what exists.
export interface FlightDetails {
	crew?: { captain?: string; first_officer?: string; attendants?: number };
	souls?: { passengers?: number; crew?: number; hijackers?: number; total?: number };
	hijackers?: string[];
	fate?: { text?: string; utc?: string };
}

export interface FlightTrack {
	flight: string;
	origin: string | null;
	scheduled_dest: string | null;
	landed_at: string | null;
	diverted: boolean;
	geometry: { type: "LineString"; coordinates: [number, number][] } | null;
	tail_number: string | null;
	aircraft_type: string | null;
	details: FlightDetails | null;
	wheels_off_utc: string | null;
	wheels_on_utc: string | null;
}

export interface TrackSelection {
	flight: string;
	startDate: string;
}

// flight_date is the UTC date component of the flight's own start_date — the
// streamer serves the 2001-09-09..09-18 window, so this is not hardcoded.
export function flightDateOf(startDate: string): string {
	return startDate.slice(0, 10);
}

export function trackUrl(flight: string, flightDate: string): string {
	const params = new URLSearchParams({
		"filter[flight][_eq]": flight,
		"filter[flight_date][_eq]": flightDate,
		fields: "flight,origin,scheduled_dest,landed_at,diverted,geometry,tail_number,aircraft_type,details,wheels_off_utc,wheels_on_utc",
		limit: "1",
	});
	return `${DIRECTUS_URL}/items/flight_tracks?${params.toString()}`;
}

// Fetch the selected flight's full track, cached by flight|date (tracks are
// immutable). Aborts an in-flight request when the selection changes or the
// component unmounts. A miss or error surfaces as `error` with a null track,
// never a throw — the map/panel degrade gracefully.
export function useFlightTrack(selection: TrackSelection | null): {
	track: FlightTrack | null;
	loading: boolean;
	error: string | null;
} {
	const [track, setTrack] = useState<FlightTrack | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cache = useRef<Map<string, FlightTrack>>(new Map());

	useEffect(() => {
		if (!selection) {
			setTrack(null);
			setError(null);
			setLoading(false);
			return;
		}
		const date = flightDateOf(selection.startDate);
		const key = `${selection.flight}|${date}`;
		const cached = cache.current.get(key);
		if (cached) {
			setTrack(cached);
			setError(null);
			setLoading(false);
			return;
		}

		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetch(trackUrl(selection.flight, date), { signal: controller.signal })
			.then(async (res) => {
				if (controller.signal.aborted) return;
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = (await res.json()) as { data: FlightTrack[] };
				const row = json.data[0] ?? null;
				if (!row) {
					setTrack(null);
					setError("Track unavailable");
				} else {
					cache.current.set(key, row);
					setTrack(row);
				}
			})
			.catch((err: unknown) => {
				if (controller.signal.aborted) return;
				// Show the panel a friendly message; keep the technical cause (a raw
				// "HTTP 403", a network error, etc.) in the console for debugging.
				// Users should never see the raw fetch error string.
				console.warn("flight track fetch failed:", err);
				setTrack(null);
				setError("Track unavailable");
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});

		return () => controller.abort();
	}, [selection]);

	return { track, loading, error };
}
