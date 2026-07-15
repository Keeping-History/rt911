import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { RouteIndex } from "./flightFilter";
import { routeRowFor } from "./flightFilter";
import { isNotable } from "./notableFlights";

// Landing semantics for the live map. A flight's motion is dead-reckoned
// between per-minute samples, which overshoots the runway (or crash site) by
// up to MAX_EXTRAPOLATION_MS once samples stop. flight_tracks.wheels_on_utc
// is the authoritative wheels-down instant, so:
//   1. Rendering clamps each flight's motion clock to its landing time — a
//      landed flight freezes exactly at its final position (landingClockOf →
//      the builders' landingMs parameter).
//   2. Landed non-notable flights leave the map LANDED_LINGER_MS after
//      wheels-down (dropLandedPositions), well before the provider's 10-min
//      instant retention would remove them.
//   3. The notables (AA11/UA175/AA77/UA93, wheels_on_utc null) are exempt
//      from (2); their crash instants arrive as overrides from
//      useNotableCrashSites, and they persist frozen at the crash site.

/** How long a landed non-notable flight lingers before leaving the map. */
export const LANDED_LINGER_MS = 2 * 60_000;

/**
 * Wheels-down UTC ms for a position's flight via the route index (same
 * flight|date join and prevUtcDay fallback as every other metadata lookup),
 * or null when unknown — crashes and missing rows never report a landing.
 */
export function landingMsFor(index: RouteIndex, p: FlightPosition): number | null {
	const wheelsOn = routeRowFor(index, p)?.wheels_on_utc;
	if (!wheelsOn) return null;
	const ms = Date.parse(wheelsOn);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * Per-flight landing clock for the airborne set: flight → wheels-down UTC ms.
 * `overrides` (the notables' crash instants) win over the route index.
 */
export function landingClockOf(
	positions: FlightPosition[],
	index: RouteIndex,
	overrides?: Map<string, number>,
): Map<string, number> {
	const landing = new Map<string, number>();
	for (const p of positions) {
		if (landing.has(p.flight)) continue;
		const ms = landingMsFor(index, p);
		if (ms !== null) landing.set(p.flight, ms);
	}
	if (overrides) for (const [flight, ms] of overrides) landing.set(flight, ms);
	return landing;
}

/**
 * Positions with landed non-notable flights removed once they've been on the
 * ground for LANDED_LINGER_MS. Notables never drop — they hold their crash
 * site; flights with no known landing time keep the existing retention
 * behavior (the provider ages them out).
 */
export function dropLandedPositions(
	positions: FlightPosition[],
	index: RouteIndex,
	nowMs: number,
): FlightPosition[] {
	return positions.filter((p) => {
		if (isNotable(p.flight)) return true;
		const landedMs = landingMsFor(index, p);
		return landedMs === null || nowMs < landedMs + LANDED_LINGER_MS;
	});
}
