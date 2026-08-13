import { useEffect, useRef, useState } from "react";
import type { AltitudeSample } from "./flightAltitude";
import type { TrackSelection } from "./useFlightTrack";
import { flightDateOf, prevUtcDay } from "./flightDates";
import { DIRECTUS_URL } from "../../lib/endpoints";

// Read over REST on the same anonymous static-reference-data path
// useFlightTrack uses. flight_positions is public-read (issue #224's grant).

export function profileUrl(flight: string, flightDate: string): string {
	const params = new URLSearchParams({
		"filter[flight][_eq]": flight,
		"filter[flight_date][_eq]": flightDate,
		fields: "lat,lon,alt_ft,utc,phase,source",
		sort: "utc",
		limit: "2000",
	});
	return `${DIRECTUS_URL}/items/flight_positions?${params.toString()}`;
}

/**
 * Per-minute altitude profile for the selected flight, feeding the 3D curtain
 * wall (curtainToGeoJSON) — and, for notable/estimated flights, the drawn track
 * itself (FlightTracker's buildTrackSegments). Getting the day wrong therefore
 * draws the wrong ROUTE, not just the wrong altitudes.
 *
 * `trackFlightDate` is the selected leg's own flight_date (useFlightTrack's
 * pickLeg result) and is authoritative when present: AF1 has rows on BOTH 9/10
 * and 9/11, so the empty-result heuristic below can never tell them apart — a
 * 9/10-evening instant is dated 9/11 in UTC, the 9/11 day is non-empty, and the
 * fallback never fires. With no track loaded yet we keep the old heuristic:
 * flight_date is the BTS *local* departure date while the selection's startDate
 * is UTC, so an empty result falls back one UTC day — the same join quirk
 * routeRowFor handles (see flightDates.prevUtcDay).
 *
 * Graceful-degrade contract matches useFlightTrack: any failure yields
 * profile null (no curtain), never a throw.
 */
export function useAltitudeProfile(
	selection: TrackSelection | null,
	trackFlightDate?: string | null,
): {
	profile: AltitudeSample[] | null;
} {
	const [profile, setProfile] = useState<AltitudeSample[] | null>(null);
	const cache = useRef<Map<string, AltitudeSample[]>>(new Map());

	useEffect(() => {
		if (!selection) {
			setProfile(null);
			return;
		}
		const date = trackFlightDate || flightDateOf(selection.startDate);
		const key = `${selection.flight}|${date}`;
		const cached = cache.current.get(key);
		if (cached) {
			setProfile(cached);
			return;
		}

		const controller = new AbortController();
		const fetchDay = async (day: string): Promise<AltitudeSample[]> => {
			const res = await fetch(profileUrl(selection.flight, day), {
				signal: controller.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data: AltitudeSample[] };
			return json.data ?? [];
		};
		void (async () => {
			try {
				let rows = await fetchDay(date);
				// Only guess when nothing told us the day: an authoritative
				// flight_date that returns nothing means nothing, not "try 9/10".
				if (rows.length === 0 && !trackFlightDate) rows = await fetchDay(prevUtcDay(date));
				if (controller.signal.aborted) return;
				cache.current.set(key, rows);
				setProfile(rows.length ? rows : null);
			} catch (err) {
				if (controller.signal.aborted) return;
				console.warn("altitude profile fetch failed:", err);
				setProfile(null);
			}
		})();

		return () => controller.abort();
	}, [selection, trackFlightDate]);

	return { profile };
}
