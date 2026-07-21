// POI markers loaded from the Directus `map_pois` collection. A POI belongs to
// a named `layer` (the toggle unit) and a `category` (render/behavior class).
// Airport-specific statistics live in the free-form `details` blob so the
// collection stays reusable for future non-airport layers with no schema change.
export interface MapPoi {
	id: number;
	name: string;
	layer: string;
	category: string;
	detailTitle: string | null;
	lat: number;
	lon: number;
	iata: string | null;
	icao: string | null;
	city: string | null;
	region: string | null;
	details: Record<string, unknown> | null;
}

// visiblePois takes the two settings primitives (not FlightPoiSettings) so this
// pure module never imports the settings/reducer module — keeps the dep graph
// acyclic and the helpers trivially testable.
export function visiblePois(
	pois: MapPoi[],
	enabled: boolean,
	disabledLayers: string[],
): MapPoi[] {
	if (!enabled) return [];
	if (disabledLayers.length === 0) return pois;
	const off = new Set(disabledLayers);
	return pois.filter((p) => !off.has(p.layer));
}

/** Unique layer names, alphabetically — drives the Layers… window's checkbox list. */
export function distinctLayers(pois: MapPoi[]): string[] {
	return [...new Set(pois.map((p) => p.layer))].sort();
}

/** Detail-pane header for a selected POI; generic fallback when unset. */
export function detailTitleFor(poi: MapPoi): string {
	return poi.detailTitle ?? "Point of Interest";
}

const thousands = (v: unknown): string =>
	typeof v === "number" ? v.toLocaleString("en-US") : String(v);

// Ordered, labeled projection of the `details` blob for the detail pane. Each
// field renders only when present (see FlightDetailPanel), so a sparse record
// simply shows fewer rows — the same conditional pattern flights already use.
export const POI_DETAIL_FIELDS: ReadonlyArray<{
	key: string;
	label: string;
	format: (v: unknown) => string;
}> = [
	{ key: "hub_class", label: "FAA hub class", format: String },
	{ key: "enplanements_2000", label: "Enplanements (2000)", format: thousands },
	{ key: "runway_count", label: "Runways", format: String },
	{ key: "longest_runway_ft", label: "Longest runway", format: (v) => `${thousands(v)} ft` },
	{ key: "elevation_ft", label: "Elevation", format: (v) => `${thousands(v)} ft` },
	{ key: "operator", label: "Operator", format: String },
	{ key: "opened_year", label: "Opened", format: String },
	{ key: "note", label: "Note", format: String },
];
