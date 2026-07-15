import { useEffect, useMemo, useState } from "react";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { NOTABLE_FLIGHTS } from "./notableFlights";

// The four notables' final moments, straight from the same flight_positions
// data the map replays: each flight's last sample IS its crash instant and
// crash site (the curated NTSB tracks end at impact — wheels_on_utc is null
// for these rows). FlightTracker re-injects these samples into the positions
// pipeline whenever the virtual clock is past the crash, so AA11/UA175/AA77/
// UA93 stay on the map, frozen at the crash site, no matter how the user
// seeks. Two samples (not one) so the motion buffer derives the true final
// heading instead of pointing north after a seek-past-crash.
//
// Same anonymous-read Directus base as useFlightTrack/useAltitudeProfile.
const DIRECTUS_URL =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ??
	"https://api-beta.911realtime.org";

// All four notables flew (and crashed) on 9/11; their BTS-local flight_date
// never straddles UTC midnight, so no prevUtcDay fallback is needed here.
const NOTABLE_FLIGHT_DATE = "2001-09-11";

export function crashSiteUrl(flight: string): string {
	const params = new URLSearchParams({
		"filter[flight][_eq]": flight,
		"filter[flight_date][_eq]": NOTABLE_FLIGHT_DATE,
		fields: "id,lat,lon,alt_ft,utc,phase",
		sort: "-utc",
		limit: "2",
	});
	return `${DIRECTUS_URL}/items/flight_positions?${params.toString()}`;
}

interface CrashApiRow {
	id: number;
	lat: number;
	lon: number;
	alt_ft: number;
	utc: string;
	phase?: string;
}

export interface NotableCrashSites {
	/** Final two samples per notable, time-ascending, as pipeline-ready positions. */
	samples: FlightPosition[];
	/** flight → crash UTC ms (its last sample's instant). */
	crashMs: Map<string, number>;
}

const EMPTY: NotableCrashSites = { samples: [], crashMs: new Map() };

// Module-level cache: the data is immutable and tiny (8 rows), so one load
// per page lifetime, shared across mounts (useRouteIndex pattern). Failures
// leave the cache unset so a later mount retries.
let cache: NotableCrashSites | null = null;
let pending = false;
const listeners = new Set<() => void>();

/** Test-only: forget the cached crash sites. */
export function resetNotableCrashCache(): void {
	cache = null;
	pending = false;
}

async function loadCrashSites(): Promise<void> {
	if (cache || pending) return;
	pending = true;
	try {
		const samples: FlightPosition[] = [];
		const crashMs = new Map<string, number>();
		// SEQUENTIAL on purpose: concurrent same-path requests to api-beta get
		// their response bodies MIXED by the proxy layer (verified 2026-07-15 —
		// four parallel flight_positions queries all received one flight's
		// rows; the same queries in series returned correct data). Four small
		// requests in series cost ~200ms once per page; wrong data forever.
		const results: { flight: string; rows: CrashApiRow[] }[] = [];
		for (const flight of NOTABLE_FLIGHTS) {
			const res = await fetch(crashSiteUrl(flight));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data: CrashApiRow[] };
			results.push({ flight, rows: json.data });
		}
		for (const { flight, rows } of results) {
			if (rows.length === 0) continue;
			crashMs.set(flight, Date.parse(rows[0].utc));
			for (const r of [...rows].reverse()) {
				samples.push({
					id: r.id,
					flight,
					carrier: flight.replace(/\d+$/, ""),
					start_date: r.utc,
					lat: r.lat,
					lon: r.lon,
					alt_ft: r.alt_ft,
					phase: r.phase,
				});
			}
		}
		cache = { samples, crashMs };
		for (const l of listeners) l();
	} catch (err) {
		// Graceful degradation: crashed notables just don't persist this session;
		// live replay through the crash still works from the stream.
		console.warn("notable crash sites fetch failed:", err);
	} finally {
		pending = false;
	}
}

/** The notables' crash sites, loaded once per page; EMPTY until resolved. */
export function useNotableCrashSites(): NotableCrashSites {
	const [version, setVersion] = useState(0);

	useEffect(() => {
		const listener = () => setVersion((v) => v + 1);
		listeners.add(listener);
		void loadCrashSites();
		return () => {
			listeners.delete(listener);
		};
	}, []);

	// `version` invalidates the memo when the load resolves.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	return useMemo(() => cache ?? EMPTY, [version]);
}
