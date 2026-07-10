import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { flightDateOf } from "./useFlightTrack";

// Filter criteria for the Filter Flights window (issue #188). Values come from
// dropdowns fed by live data, so matching is exact; "" means "any". Criteria
// AND together.
export interface FlightFilter {
	flight: string;
	tail: string;
	carrier: string;
	origin: string;
	dest: string;
}

export const EMPTY_FLIGHT_FILTER: FlightFilter = {
	flight: "",
	tail: "",
	carrier: "",
	origin: "",
	dest: "",
};

// Per-flight static route metadata from Directus flight_tracks (no geometry).
// flight_tracks has no readable carrier column — carrier lives only on the
// streamed FlightPosition.
export interface RouteIndexRow {
	tail_number: string | null;
	origin: string | null;
	scheduled_dest: string | null;
}

/** Keyed by routeKey(flight, flight_date). */
export type RouteIndex = Map<string, RouteIndexRow>;

export function routeKey(flight: string, flightDate: string): string {
	return `${flight}|${flightDate}`;
}

export function isFilterActive(f: FlightFilter): boolean {
	return !!(f.flight || f.tail || f.carrier || f.origin || f.dest);
}

// A flight missing the metadata a criterion needs fails that criterion — e.g.
// with a Departure filter set, a flight with no route-index row is hidden.
export function matchesFilter(
	p: FlightPosition,
	row: RouteIndexRow | undefined,
	f: FlightFilter,
): boolean {
	if (f.flight && p.flight !== f.flight) return false;
	if (f.carrier && p.carrier !== f.carrier) return false;
	if (f.tail && row?.tail_number !== f.tail) return false;
	if (f.origin && row?.origin !== f.origin) return false;
	if (f.dest && row?.scheduled_dest !== f.dest) return false;
	return true;
}

// null = filter inactive → callers show everything with zero per-frame cost.
export function visibleFlightSet(
	positions: FlightPosition[],
	index: RouteIndex,
	f: FlightFilter,
): Set<string> | null {
	if (!isFilterActive(f)) return null;
	const visible = new Set<string>();
	for (const p of positions) {
		const row = index.get(routeKey(p.flight, flightDateOf(p.start_date)));
		if (matchesFilter(p, row, f)) visible.add(p.flight);
	}
	return visible;
}

// Distinct non-empty values, sorted, behind an "Any" first entry. The current
// selection is synthesized in when absent (a filtered flight landing must not
// silently self-clear the filter).
export function popUpOptions(
	values: (string | null | undefined)[],
	selected: string,
): { value: string; label: string }[] {
	const set = new Set<string>();
	for (const v of values) if (v) set.add(v);
	if (selected) set.add(selected);
	return [
		{ value: "", label: "Any" },
		...[...set].sort().map((v) => ({ value: v, label: v })),
	];
}
