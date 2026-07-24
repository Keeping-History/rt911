import { useEffect, useState } from "react";
import { type HeroManifestEntry, parseHeroManifest } from "./heroBuildings";

export const HERO_MANIFEST_URL =
  (import.meta.env.VITE_HERO_BUILDINGS_URL as string | undefined) ??
  "https://files.911realtime.org/maps/hero-buildings.json";

let cache: HeroManifestEntry[] | null = null;
let pending = false;
const listeners = new Set<() => void>();

export function resetHeroBuildingsCache(): void {
  cache = null;
  pending = false;
}

async function loadHeroBuildings(): Promise<void> {
  if (cache || pending) return;
  pending = true;
  try {
    const res = await fetch(HERO_MANIFEST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache = parseHeroManifest(await res.json());
    for (const l of listeners) l();
  } catch (err) {
    console.warn("hero manifest fetch failed:", err);
    cache = [];
    for (const l of listeners) l();
  } finally {
    pending = false;
  }
}

/** Hero manifest entries, loaded once per page; [] until resolved (or on failure). */
export function useHeroBuildings(): HeroManifestEntry[] {
  const [heroes, setHeroes] = useState<HeroManifestEntry[]>(cache ?? []);
  useEffect(() => {
    const listener = () => setHeroes(cache ?? []);
    listeners.add(listener);
    if (cache) setHeroes(cache);
    else void loadHeroBuildings();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return heroes;
}
