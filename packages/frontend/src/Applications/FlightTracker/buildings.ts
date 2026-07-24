import type { BuildingFootprint } from "./buildingMesh";

// Single static Wasabi asset (Plan 2 produces it). Env-overridable so dev can
// point at the committed public/maps/buildings-2001.sample.geojson fixture.
export const BUILDINGS_URL =
  (import.meta.env.VITE_BUILDINGS_URL as string | undefined) ??
  "https://files.911realtime.org/maps/buildings-2001.geojson";

// City-detail zoom. Below this the continental default view is unchanged and the
// (tiny) impact-zone geometry stays hidden; buildings read best pitched + zoomed.
export const BUILDINGS_MIN_ZOOM = 12;

export function buildingsVisibleAtZoom(zoom: number): boolean {
  return zoom >= BUILDINGS_MIN_ZOOM;
}

// Quiet neutral gray so hero landmarks + flights stay the focus. Radar (always
// dark, monochrome scope) gets its own dim tone.
export function buildingColorRgb(
  mapStyle: "classic" | "radar" | "satellite",
  darkMap: boolean,
): [number, number, number] {
  if (mapStyle === "radar") return [0.28, 0.42, 0.3];
  return darkMap ? [0.5, 0.5, 0.53] : [0.62, 0.62, 0.64];
}

export function intToRgb01(n: number): [number, number, number] {
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function heroColorRgb(settings: {
  darkMap: boolean;
  buildingHeroColorLight: number;
  buildingHeroColorDark: number;
}): [number, number, number] {
  return intToRgb01(settings.darkMap ? settings.buildingHeroColorDark : settings.buildingHeroColorLight);
}

interface GeoJSONPolygonFeature {
  properties?: { height_m?: number; base_elevation_m?: number } | null;
  geometry?: { type?: string; coordinates?: number[][][] } | null;
}

/** GeoJSON FeatureCollection -> footprints; skips non-polygons / non-positive heights. */
export function parseBuildingsGeoJSON(json: unknown): BuildingFootprint[] {
  const features = (json as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: BuildingFootprint[] = [];
  for (const raw of features as GeoJSONPolygonFeature[]) {
    if (raw?.geometry?.type !== "Polygon") continue;
    const outer = raw.geometry.coordinates?.[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;
    const heightM = Number(raw.properties?.height_m);
    if (!(heightM > 0)) continue;
    const baseElevM = Number(raw.properties?.base_elevation_m ?? 0) || 0;
    out.push({
      ring: outer.map((p) => [p[0], p[1]] as [number, number]),
      baseElevM,
      heightM,
    });
  }
  return out;
}
