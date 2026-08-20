import type { BuildingFootprint, HeroPlacement } from "./buildingMesh";

// Hero landmark models (WTC complex, Pentagon) replace their extruded footprints
// with detailed STL geometry. The manifest is a small JSON on Wasabi; each entry
// carries an `exclude` bbox whose covered extruded footprints are hidden ONLY
// once the hero's STL has loaded (so a failed load leaves the extruded fallback).

export interface HeroManifestEntry {
  id: string;
  stlPath: string;
  lng: number;
  lat: number;
  bearingDeg: number;
  scale: number;
  baseElevM: number;
  exclude: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseHeroManifest(json: unknown): HeroManifestEntry[] {
  const heroes = (json as { heroes?: unknown } | null)?.heroes;
  if (!Array.isArray(heroes)) return [];
  const out: HeroManifestEntry[] = [];
  for (const raw of heroes as Record<string, unknown>[]) {
    const lng = num(raw.lng), lat = num(raw.lat);
    const bearingDeg = num(raw.bearing_deg), scale = num(raw.scale), baseElevM = num(raw.base_elev_m);
    const ex = raw.exclude;
    if (typeof raw.id !== "string" || typeof raw.stl_url !== "string") continue;
    if (lng === null || lat === null || bearingDeg === null || scale === null || baseElevM === null) continue;
    if (!Array.isArray(ex) || ex.length !== 4 || ex.some((v) => num(v) === null)) continue;
    out.push({
      id: raw.id, stlPath: raw.stl_url, lng, lat, bearingDeg, scale, baseElevM,
      exclude: [Number(ex[0]), Number(ex[1]), Number(ex[2]), Number(ex[3])],
    });
  }
  return out;
}

export function manifestToPlacement(e: HeroManifestEntry): HeroPlacement {
  return { lng: e.lng, lat: e.lat, bearingDeg: e.bearingDeg, scale: e.scale, baseElevM: e.baseElevM };
}

export function centroidInExclude(
  ring: [number, number][], bbox: [number, number, number, number],
): boolean {
  if (ring.length === 0) return false;
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length; cy /= ring.length;
  const [mnX, mnY, mxX, mxY] = bbox;
  return cx >= mnX && cx <= mxX && cy >= mnY && cy <= mxY;
}

export function excludeFootprints(
  features: BuildingFootprint[], activeBboxes: [number, number, number, number][],
): BuildingFootprint[] {
  if (activeBboxes.length === 0) return features;
  return features.filter((f) => !activeBboxes.some((b) => centroidInExclude(f.ring, b)));
}
