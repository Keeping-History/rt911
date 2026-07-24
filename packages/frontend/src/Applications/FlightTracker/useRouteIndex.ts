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

// Row counts vary by an order of magnitude between dates, so multi-page walks
// are routine, not an edge case: 2001-09-11 has ~1,950 rows (one page) but
// 2001-09-10 has ~16,367 (six) — both checked 2026-07-24, after the
// flight-recon reload. Note that each sample date fetches two dates' worth of
// rows (see datesKey below), so the number of fetches is up to 2x the number
// of distinct sample dates.
export const ROUTE_INDEX_PAGE_LIMIT = 3000;

// Hard ceiling on pages walked per date. The largest date in the reloaded
// dataset (2001-09-10) is ~16.4k rows = 6 pages, so 25 pages (75k rows) is far
// beyond anything real. This is a circuit breaker, not a tuning knob: the
// short-page break below delegates loop termination entirely to the server, so
// any layer that answers every `page=N` with the same full-page body makes it
// run forever. That is not hypothetical — an edge cache ignoring the query
// string did exactly this in production (2026-07-22 and again 2026-07-24), and
// the origin logged this loop reaching page 5883 against a 6-page date.
export const ROUTE_INDEX_MAX_PAGES = 25;

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
		// Postgres gives no ordering guarantee for LIMIT/OFFSET without an
		// ORDER BY, so an unsorted page walk may repeat or skip rows across page
		// boundaries. Sorting on the primary key makes the paging deterministic.
		sort: "id",
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
		let complete = false;
		// First row of the previous page. A page that starts where the last one
		// started means the server handed back the same body rather than the next
		// slice — the request is not making progress, so keep walking and this
		// loop never ends. Bail on the very next page instead of thousands later.
		let prevFirstKey: string | null = null;
		for (let page = 1; page <= ROUTE_INDEX_MAX_PAGES; page++) {
			const res = await fetch(routeIndexUrl(date, page));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data: RouteIndexApiRow[] };
			const data = json.data ?? [];
			const firstKey = data.length ? routeKey(data[0].flight, data[0].flight_date) : null;
			if (firstKey !== null && firstKey === prevFirstKey) {
				throw new Error(
					`page ${page} repeated page ${page - 1} (stale query-agnostic cache?)`,
				);
			}
			prevFirstKey = firstKey;
			for (const r of data) {
				rows.set(routeKey(r.flight, r.flight_date), {
					tail_number: r.tail_number ?? null,
					origin: r.origin ?? null,
					scheduled_dest: r.scheduled_dest ?? null,
					aircraft_type: r.aircraft_type ?? null,
					wheels_on_utc: r.wheels_on_utc ?? null,
				});
			}
			if (data.length < ROUTE_INDEX_PAGE_LIMIT) {
				complete = true;
				break;
			}
		}
		// Deliberately not cached when the walk was cut short: a truncated index
		// silently hides flights from every filter for the rest of the session,
		// whereas leaving the date uncached lets a later mount retry once the
		// upstream recovers.
		if (!complete) {
			throw new Error(`exceeded ${ROUTE_INDEX_MAX_PAGES} pages`);
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
		// Dates load in SERIES: concurrent same-path requests to api-beta can
		// come back with their response bodies mixed by the proxy layer (see
		// useNotableCrashSites.loadCrashSites) — a poisoned date would cache
		// another date's rows permanently.
		if (datesKey) {
			void (async () => {
				for (const date of datesKey.split(",")) await loadDate(date);
			})();
		}
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
