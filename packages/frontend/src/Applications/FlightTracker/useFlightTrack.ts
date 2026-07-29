import { useEffect, useRef, useState } from "react";
import { DIRECTUS_URL } from "../../lib/endpoints";

// Track geometry is static per flight, so it is fetched over REST, not
// streamed — the same static-reference-data path the Time Machine bookmarks
// use (see TimeMachine/useBookmarks.ts).

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
		// Multi-leg flight numbers (e.g. WN6 flying several legs on 9/11) have
		// one row PER LEG — fetch them all and pick by time (pickLeg below).
		limit: "10",
	});
	return `${DIRECTUS_URL}/items/flight_tracks?${params.toString()}`;
}

// Slack around a leg's wheels span when matching the selection instant —
// positions exist a little before wheels-off (taxi/radar pickup) and the
// click can land just after wheels-on while the pin lingers.
const LEG_SLACK_MS = 10 * 60_000;

/**
 * The leg whose [wheels_off, wheels_on] span (with slack) contains the
 * selection instant. Single-row responses (almost every flight) short-circuit;
 * with no time match the earliest leg wins — the previous behavior, but
 * deterministic instead of row-order luck.
 */
export function pickLeg(rows: FlightTrack[], atMs: number): FlightTrack | null {
	if (rows.length <= 1) return rows[0] ?? null;
	const spanOf = (r: FlightTrack): [number, number] => [
		r.wheels_off_utc ? Date.parse(r.wheels_off_utc) - LEG_SLACK_MS : Number.NEGATIVE_INFINITY,
		r.wheels_on_utc ? Date.parse(r.wheels_on_utc) + LEG_SLACK_MS : Number.POSITIVE_INFINITY,
	];
	const inSpan = rows.filter((r) => {
		const [lo, hi] = spanOf(r);
		return atMs >= lo && atMs <= hi;
	});
	const pool = inSpan.length > 0 ? inSpan : rows;
	return [...pool].sort((a, b) => {
		const ta = a.wheels_off_utc ? Date.parse(a.wheels_off_utc) : 0;
		const tb = b.wheels_off_utc ? Date.parse(b.wheels_off_utc) : 0;
		return ta - tb;
	})[0];
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
		const atMs = Date.parse(selection.startDate);
		// Cache per selection instant's leg, not just per flight — a multi-leg
		// number resolves to different rows at different times of day.
		const key = `${selection.flight}|${date}|${Number.isNaN(atMs) ? 0 : Math.floor(atMs / 3_600_000)}`;
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
				const row = pickLeg(json.data, atMs);
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
