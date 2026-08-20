import type { FlightPoiSettings } from "./flightMapSettings";

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

// Distinct, legible-on-both-tones cluster-dot colors, indexed by layer. Cycles
// if there are ever more layers than entries.
export const POI_LAYER_PALETTE: readonly string[] = [
	"#c0202a", // red
	"#1f6feb", // blue
	"#2e8b57", // sea green
	"#b8860b", // dark goldenrod
	"#8a2be2", // blue violet
	"#e0692b", // orange
];

export interface PoiLayerConfig {
	layer: string;
	index: number;
	color: string;
	clustered: boolean;
}

/** One config per ENABLED layer (sorted), with its palette color + clustering flag. */
export function poiLayerConfigs(
	allPois: MapPoi[],
	settings: FlightPoiSettings,
): PoiLayerConfig[] {
	if (!settings.enabled) return [];
	const off = new Set(settings.disabledLayers);
	const unclustered = new Set(settings.unclusteredLayers);
	return distinctLayers(allPois)
		.filter((l) => !off.has(l))
		.map((layer, index) => ({
			layer,
			index,
			color: POI_LAYER_PALETTE[index % POI_LAYER_PALETTE.length],
			clustered: !unclustered.has(layer),
		}));
}

export const LARGEST_HUB_CLASS = "Large";

/** Airport POIs are limited to Large hubs; other categories pass through. */
export function unclusteredAirportFilter(pois: MapPoi[]): MapPoi[] {
	return pois.filter(
		(p) => p.category !== "airport" || p.details?.hub_class === LARGEST_HUB_CLASS,
	);
}

/** Partition enabled POIs into the clustered vs plain source feeds. */
export function splitPoisForRender(
	enabledPois: MapPoi[],
	configs: PoiLayerConfig[],
): { clustered: MapPoi[]; plain: MapPoi[] } {
	const clusteredLayers = new Set(configs.filter((c) => c.clustered).map((c) => c.layer));
	const clustered = enabledPois.filter((p) => clusteredLayers.has(p.layer));
	const plain = unclusteredAirportFilter(
		enabledPois.filter((p) => !clusteredLayers.has(p.layer)),
	);
	return { clustered, plain };
}

/** layer name → config index (for the GeoJSON stamp + cluster-color match). */
export function layerIndexOf(configs: PoiLayerConfig[]): Map<string, number> {
	return new Map(configs.map((c) => [c.layer, c.index]));
}
