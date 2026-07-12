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

// flight_tracks.flight_date is the BTS *local* departure date, but a
// FlightPosition's start_date (and flightDateOf, which takes its UTC date
// component) is a UTC instant. An evening flight departing e.g. 8:30 PM ET on
// 9/12 has flight_date = "2001-09-12" while every one of its samples is dated
// "2001-09-13" UTC (00:30Z onward) — so joining strictly on
// routeKey(flight, flightDateOf(start_date)) misses it. Across every US
// timezone in this dataset, flight_date is always either the sample's UTC
// date or the day before it, so a lookup falls back one UTC day before
// giving up.
export function prevUtcDay(flightDate: string): string {
	return new Date(Date.parse(`${flightDate}T00:00:00Z`) - 86_400_000)
		.toISOString()
		.slice(0, 10);
}

// Joins a streamed position to its route-index row across that local/UTC
// flight_date boundary: try the sample's own UTC date first (the common
// case), then fall back to the previous UTC day (the evening-departure case
// described above).
export function routeRowFor(
	index: RouteIndex,
	p: FlightPosition,
): RouteIndexRow | undefined {
	const d = flightDateOf(p.start_date);
	return index.get(routeKey(p.flight, d)) ?? index.get(routeKey(p.flight, prevUtcDay(d)));
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
		const row = routeRowFor(index, p);
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
