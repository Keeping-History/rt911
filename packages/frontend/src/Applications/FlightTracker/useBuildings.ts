import { useEffect, useState } from "react";
import type { BuildingFootprint } from "./buildingMesh";
import { BUILDINGS_URL, parseBuildingsGeoJSON } from "./buildings";

// Module-level cache: the 2001 skyline is immutable and small, so one load per
// page lifetime, shared across mounts (useMapPois pattern).
let cache: BuildingFootprint[] | null = null;
let pending = false;
const listeners = new Set<() => void>();

export function resetBuildingsCache(): void {
  cache = null;
  pending = false;
}

async function loadBuildings(): Promise<void> {
  if (cache || pending) return;
  pending = true;
  try {
    const res = await fetch(BUILDINGS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache = parseBuildingsGeoJSON(await res.json());
    for (const l of listeners) l();
  } catch (err) {
    // Graceful degradation: no buildings this session; the rest of the map works.
    console.warn("buildings fetch failed:", err);
    cache = [];
    for (const l of listeners) l();
  } finally {
    pending = false;
  }
}

/** The 2001 footprints, loaded once per page; [] until resolved (or on failure). */
export function useBuildings(): BuildingFootprint[] {
  const [buildings, setBuildings] = useState<BuildingFootprint[]>(cache ?? []);
  useEffect(() => {
    const listener = () => setBuildings(cache ?? []);
    listeners.add(listener);
    if (cache) setBuildings(cache);
    else void loadBuildings();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return buildings;
}
