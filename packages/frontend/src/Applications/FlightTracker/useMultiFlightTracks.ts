import { useEffect, useRef, useState } from "react";
import type { AltitudeSample } from "./flightAltitude";
import { flightDateOf } from "./flightDates";
import { profileUrl } from "./useAltitudeProfile";
import { type FlightTrack, pickLeg, trackUrl, type TrackSelection } from "./useFlightTrack";

export interface SecondaryTrack {
	flight: string;
	geometry: FlightTrack["geometry"];
	profile: AltitudeSample[] | null;
}

/**
 * Plain (unphased) geometry + altitude profile for every multi-selected
 * flight OTHER than the active one — the active flight keeps its own richer
 * useFlightTrack/useAltitudeProfile pair (detail panel, phase coloring).
 * This is what lets shift-click and the area-select tools show every
 * selected flight's track on the map, not just the one shown in the detail
 * pane's dropdown.
 *
 * Cached by flight|date|hour across renders, mirroring useFlightTrack's key
 * (a multi-leg flight number resolves to different rows at different times
 * of day). Profile is fetched using the track's OWN flight_date, the same
 * authoritative-date pattern useAltitudeProfile uses for the active flight —
 * no day-guessing needed since the track fetch already resolved it.
 */
export function useMultiFlightTracks(selections: TrackSelection[]): Map<string, SecondaryTrack> {
	const [tracks, setTracks] = useState<Map<string, SecondaryTrack>>(new Map());
	const cache = useRef<Map<string, SecondaryTrack>>(new Map());

	useEffect(() => {
		if (selections.length === 0) {
			setTracks(new Map());
			return;
		}
		const controller = new AbortController();

		const fetchOne = async (
			selection: TrackSelection,
		): Promise<[string, SecondaryTrack] | null> => {
			const date = flightDateOf(selection.startDate);
			const atMs = Date.parse(selection.startDate);
			const key = `${selection.flight}|${date}|${Number.isNaN(atMs) ? 0 : Math.floor(atMs / 3_600_000)}`;
			const cached = cache.current.get(key);
			if (cached) return [selection.flight, cached];

			try {
				const trackRes = await fetch(trackUrl(selection.flight, date), {
					signal: controller.signal,
				});
				if (!trackRes.ok) throw new Error(`HTTP ${trackRes.status}`);
				const trackJson = (await trackRes.json()) as { data: FlightTrack[] };
				const row = pickLeg(trackJson.data, atMs);
				if (!row) return null;

				const profileRes = await fetch(profileUrl(selection.flight, row.flight_date), {
					signal: controller.signal,
				});
				const profileJson = profileRes.ok
					? ((await profileRes.json()) as { data: AltitudeSample[] })
					: null;

				const entry: SecondaryTrack = {
					flight: selection.flight,
					geometry: row.geometry,
					profile: profileJson?.data?.length ? profileJson.data : null,
				};
				cache.current.set(key, entry);
				return [selection.flight, entry];
			} catch (err) {
				if (controller.signal.aborted) return null;
				console.warn("secondary flight track fetch failed:", err);
				return null;
			}
		};

		void Promise.all(selections.map(fetchOne)).then((results) => {
			if (controller.signal.aborted) return;
			setTracks(
				new Map(results.filter((r): r is [string, SecondaryTrack] => r !== null)),
			);
		});

		return () => controller.abort();
	}, [selections]);

	return tracks;
}
