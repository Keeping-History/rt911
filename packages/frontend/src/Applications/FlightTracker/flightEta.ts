import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { airportCoords, haversineNm } from "./airports";

// Detail-pane leg estimates (issue #227). The stream carries no groundspeed,
// so speed derives from the selected flight's last two minute-bucket samples.

// Below this sample gap the derived speed is numerical noise (buckets are
// nominally 60 s apart; duplicates arrive on reconnects).
const MIN_SPEED_SAMPLE_GAP_MS = 30_000;

/** Knots from two consecutive samples; null when unusable (gap too small,
 * stationary, or no previous sample yet). */
export function groundspeedKts(
	prev: FlightPosition | null,
	cur: FlightPosition,
): number | null {
	if (!prev) return null;
	const dtMs = Date.parse(cur.start_date) - Date.parse(prev.start_date);
	if (dtMs < MIN_SPEED_SAMPLE_GAP_MS) return null;
	const nm = haversineNm([prev.lon, prev.lat], [cur.lon, cur.lat]);
	if (nm === 0) return null;
	return nm / (dtMs / 3_600_000);
}

/** "40.71° N, 74.01° W" — degrees with hemisphere letters. */
export function formatCoords(lat: number, lon: number): string {
	const latHemi = lat >= 0 ? "N" : "S";
	const lonHemi = lon >= 0 ? "E" : "W";
	return `${Math.abs(lat).toFixed(2)}° ${latHemi}, ${Math.abs(lon).toFixed(2)}° ${lonHemi}`;
}

/** "1 h 23 m" / "12 m"; sub-minute durations round up to "1 m". */
export function formatDurationMs(ms: number): string {
	const totalMin = Math.max(1, Math.round(ms / 60_000));
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h} h ${m} m` : `${m} m`;
}

export interface LegEstimates {
	fromOrigin: { distanceNm: number; elapsedMs: number } | null;
	// etaMs null = distance known but speed isn't (no "(est.)" time shown).
	toDest: { distanceNm: number; etaMs: number | null } | null;
}

/**
 * From-origin and to-destination estimates for the live fix. fromOrigin needs
 * origin coords AND a wheels-off already in the replay past; toDest needs dest
 * coords and is suppressed entirely once the flight has landed (nowMs past
 * wheels-on) — an "estimate" for a landed flight would just be wrong.
 */
export function legEstimates(args: {
	live: FlightPosition;
	prev: FlightPosition | null;
	origin: string | null;
	dest: string | null;
	wheelsOffUtc: string | null;
	wheelsOnUtc: string | null;
	nowMs: number;
}): LegEstimates {
	const { live, prev, origin, dest, wheelsOffUtc, wheelsOnUtc, nowMs } = args;
	const here: [number, number] = [live.lon, live.lat];

	let fromOrigin: LegEstimates["fromOrigin"] = null;
	const originPt = airportCoords(origin);
	if (originPt && wheelsOffUtc) {
		const off = Date.parse(wheelsOffUtc);
		if (nowMs >= off) {
			fromOrigin = { distanceNm: haversineNm(originPt, here), elapsedMs: nowMs - off };
		}
	}

	let toDest: LegEstimates["toDest"] = null;
	const destPt = airportCoords(dest);
	const landed = wheelsOnUtc != null && nowMs >= Date.parse(wheelsOnUtc);
	if (destPt && !landed) {
		const distanceNm = haversineNm(here, destPt);
		const kts = groundspeedKts(prev, live);
		toDest = {
			distanceNm,
			etaMs: kts && kts > 0 ? (distanceNm / kts) * 3_600_000 : null,
		};
	}

	return { fromOrigin, toDest };
}
