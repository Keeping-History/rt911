// IATA → [lon, lat] for every origin/scheduled_dest code in flight_tracks.
// airports.json is GENERATED — see scripts/build-airports.md; do not hand-edit.
import airportData from "./airports.json";

const AIRPORTS = airportData as Record<string, [number, number]>;

/** Coordinates for an IATA code, or null when unknown/absent. */
export function airportCoords(iata: string | null | undefined): [number, number] | null {
	if (!iata) return null;
	return AIRPORTS[iata.toUpperCase()] ?? null;
}

const EARTH_RADIUS_NM = 3440.065;

/** Great-circle distance between two [lon, lat] points, in nautical miles. */
export function haversineNm(a: [number, number], b: [number, number]): number {
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const [lon1, lat1] = a;
	const [lon2, lat2] = b;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(h));
}
