import { useEffect, useState } from "react";
import type { MapPoi } from "./mapPois";

// Same anonymous-read Directus base as useNotableCrashSites/useFlightTrack.
const DIRECTUS_URL =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ??
	"https://api-beta.911realtime.org";

const FIELDS =
	"id,name,layer,category,detail_title,lat,lon,iata,icao,city,region,details";

/** Single limit=-1 query — one request avoids the api-beta parallel-mix bug. */
export function mapPoisUrl(): string {
	const params = new URLSearchParams({
		fields: FIELDS,
		limit: "-1",
		sort: "sort,name",
	});
	return `${DIRECTUS_URL}/items/map_pois?${params.toString()}`;
}

interface PoiApiRow {
	id: number;
	name: string;
	layer: string;
	category: string;
	detail_title: string | null;
	lat: number;
	lon: number;
	iata: string | null;
	icao: string | null;
	city: string | null;
	region: string | null;
	details: Record<string, unknown> | null;
}

function toMapPoi(r: PoiApiRow): MapPoi {
	return {
		id: r.id, name: r.name, layer: r.layer, category: r.category,
		detailTitle: r.detail_title, lat: r.lat, lon: r.lon,
		iata: r.iata, icao: r.icao, city: r.city, region: r.region,
		details: r.details,
	};
}

// Module-level cache: the data is immutable and small (~380 rows), so one load
// per page lifetime, shared across mounts (useNotableCrashSites pattern).
let cache: MapPoi[] | null = null;
let pending = false;
const listeners = new Set<() => void>();

/** Test-only: forget the cached POIs. */
export function resetMapPoisCache(): void {
	cache = null;
	pending = false;
}

async function loadMapPois(): Promise<void> {
	if (cache || pending) return;
	pending = true;
	try {
		const res = await fetch(mapPoisUrl());
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = (await res.json()) as { data: PoiApiRow[] };
		cache = json.data.map(toMapPoi);
		for (const l of listeners) l();
	} catch (err) {
		// Graceful degradation: no POIs this session; the rest of the map works.
		console.warn("map POIs fetch failed:", err);
	} finally {
		pending = false;
	}
}

/** The POIs, loaded once per page; [] until resolved (or on failure). */
export function useMapPois(): MapPoi[] {
	const [pois, setPois] = useState<MapPoi[]>(cache ?? []);
	useEffect(() => {
		const listener = () => setPois(cache ?? []);
		listeners.add(listener);
		if (cache) setPois(cache);
		else void loadMapPois();
		return () => { listeners.delete(listener); };
	}, []);
	return pois;
}
