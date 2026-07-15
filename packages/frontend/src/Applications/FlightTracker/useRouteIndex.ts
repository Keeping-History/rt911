import { useEffect, useMemo, useState } from "react";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { prevUtcDay, routeKey, type RouteIndex, type RouteIndexRow } from "./flightFilter";
import { flightDateOf } from "./useFlightTrack";

// Same anonymous-read Directus base as useFlightTrack; the route index is the
// bulk sibling of that per-flight fetch — every flight_tracks row for a date,
// small fields only (no geometry), so airport/tail filters can see all
// airborne flights at once instead of issuing hundreds of per-flight requests.
const DIRECTUS_URL =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ??
	"https://api-beta.911realtime.org";

// 2001-09-11 has ~1,949 rows (checked 2026-07-10), so one page per date is
// the norm; pagination is a guard, not the expectation. Note that each
// sample date fetches two dates' worth of rows (see datesKey below), so the
// number of fetches is up to 2x the number of distinct sample dates.
export const ROUTE_INDEX_PAGE_LIMIT = 3000;

interface RouteIndexApiRow extends RouteIndexRow {
	flight: string;
	flight_date: string;
}

export function routeIndexUrl(flightDate: string, page: number): string {
	const params = new URLSearchParams({
		"filter[flight_date][_eq]": flightDate,
		// flight_tracks has no readable carrier column; carrier filtering uses
		// the streamed position instead (see flightFilter.matchesFilter).
		fields: "flight,flight_date,tail_number,origin,scheduled_dest,aircraft_type,wheels_on_utc",
		limit: String(ROUTE_INDEX_PAGE_LIMIT),
		page: String(page),
	});
	return `${DIRECTUS_URL}/items/flight_tracks?${params.toString()}`;
}

// Module-level cache: tracks are immutable, so a loaded date never reloads and
// deliberately survives unmount (same reasoning as useFlightTrack's cache, but
// shared — the fetch is ~100s of KB, not per-flight). Failures leave the date
// uncached so a later mount retries.
const routeIndexCache = new Map<string, Map<string, RouteIndexRow>>();
const pendingDates = new Set<string>();
const listeners = new Set<() => void>();

/** Test-only: forget every cached/pending date. */
export function resetRouteIndexCache(): void {
	routeIndexCache.clear();
	pendingDates.clear();
}

async function loadDate(date: string): Promise<void> {
	if (routeIndexCache.has(date) || pendingDates.has(date)) return;
	pendingDates.add(date);
	try {
		const rows = new Map<string, RouteIndexRow>();
		for (let page = 1; ; page++) {
			const res = await fetch(routeIndexUrl(date, page));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data: RouteIndexApiRow[] };
			for (const r of json.data) {
				rows.set(routeKey(r.flight, r.flight_date), {
					tail_number: r.tail_number ?? null,
					origin: r.origin ?? null,
					scheduled_dest: r.scheduled_dest ?? null,
					aircraft_type: r.aircraft_type ?? null,
					wheels_on_utc: r.wheels_on_utc ?? null,
				});
			}
			if (json.data.length < ROUTE_INDEX_PAGE_LIMIT) break;
		}
		routeIndexCache.set(date, rows);
		for (const l of listeners) l();
	} catch (err) {
		// Graceful degradation: index-backed filter criteria match nothing for
		// this date until a later mount retries. Warn for debugging; no user-
		// facing error UI (the status bar's "filtered" cue explains an empty map).
		console.warn("route index fetch failed:", err);
	} finally {
		pendingDates.delete(date);
	}
}

/**
 * Route metadata for every flight on the dates present in `positions`, keyed
 * by routeKey(flight, flight_date). Grows as dates finish loading; empty until
 * the first fetch resolves.
 */
export function useRouteIndex(positions: FlightPosition[]): RouteIndex {
	// Stable key of distinct dates so effects/memos don't churn per position tick.
	// Each sample's own UTC date AND the day before it are both loaded: an
	// evening-departure flight's flight_date (BTS local date) lands on the
	// previous UTC day from its samples' start_date (see flightFilter.prevUtcDay
	// for the full local-vs-UTC explanation), so routeRowFor's fallback lookup
	// needs that earlier date's index already fetched.
	const datesKey = useMemo(() => {
		const dates = new Set<string>();
		for (const p of positions) {
			const d = flightDateOf(p.start_date);
			dates.add(d);
			dates.add(prevUtcDay(d));
		}
		return [...dates].sort().join(",");
	}, [positions]);

	const [version, setVersion] = useState(0);

	useEffect(() => {
		const listener = () => setVersion((v) => v + 1);
		listeners.add(listener);
		if (datesKey) for (const date of datesKey.split(",")) void loadDate(date);
		return () => {
			listeners.delete(listener);
		};
	}, [datesKey]);

	return useMemo(() => {
		const merged: RouteIndex = new Map();
		if (datesKey) {
			for (const date of datesKey.split(",")) {
				const rows = routeIndexCache.get(date);
				if (rows) for (const [k, v] of rows) merged.set(k, v);
			}
		}
		return merged;
		// `version` invalidates the memo when a date finishes loading.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [datesKey, version]);
}
