import { useEffect, useRef, useState } from "react";
import type { AltitudeSample } from "./flightAltitude";
import type { TrackSelection } from "./useFlightTrack";
import { flightDateOf } from "./useFlightTrack";
import { prevUtcDay } from "./flightFilter";

// Directus REST base — same anonymous static-reference-data path useFlightTrack
// uses. flight_positions is public-read (issue #224's grant).
const DIRECTUS_URL =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ??
	"https://api-beta.911realtime.org";

export function profileUrl(flight: string, flightDate: string): string {
	const params = new URLSearchParams({
		"filter[flight][_eq]": flight,
		"filter[flight_date][_eq]": flightDate,
		fields: "lat,lon,alt_ft,utc,phase",
		sort: "utc",
		limit: "2000",
	});
	return `${DIRECTUS_URL}/items/flight_positions?${params.toString()}`;
}

/**
 * Per-minute altitude profile for the selected flight, feeding the 3D curtain
 * wall (curtainToGeoJSON). flight_date is the BTS *local* departure date while
 * the selection's startDate is UTC, so an empty result falls back one UTC day
 * — the same join quirk routeRowFor handles (see flightFilter.prevUtcDay).
 *
 * Graceful-degrade contract matches useFlightTrack: any failure yields
 * profile null (no curtain), never a throw.
 */
export function useAltitudeProfile(selection: TrackSelection | null): {
	profile: AltitudeSample[] | null;
} {
	const [profile, setProfile] = useState<AltitudeSample[] | null>(null);
	const cache = useRef<Map<string, AltitudeSample[]>>(new Map());

	useEffect(() => {
		if (!selection) {
			setProfile(null);
			return;
		}
		const date = flightDateOf(selection.startDate);
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
				if (rows.length === 0) rows = await fetchDay(prevUtcDay(date));
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
	}, [selection]);

	return { profile };
}
