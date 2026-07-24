import { parseBinaryStl } from "./aircraftModels";
import type { PlaneMesh } from "./plane3dMesh";

// Hero landmark STL models (WTC complex, Pentagon), hosted on Wasabi under
// maps/heroes/. Mirrors aircraftModels.loadAircraftMesh: cached-forever (assets
// are immutable), null + warn on failure so a bad asset degrades to the extruded
// fallback rather than throwing.
const HERO_MODELS_BASE =
	(import.meta.env.VITE_HERO_MODELS_URL as string | undefined) ??
	"https://files.911realtime.org";

const meshPromises = new Map<string, Promise<PlaneMesh | null>>();

export function loadHeroStl(stlPath: string): Promise<PlaneMesh | null> {
	let p = meshPromises.get(stlPath);
	if (!p) {
		p = fetch(`${HERO_MODELS_BASE}/${stlPath}`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return parseBinaryStl(await res.arrayBuffer());
			})
			.catch((err: unknown) => {
				console.warn(`hero model ${stlPath} unavailable:`, err);
				return null;
			});
		meshPromises.set(stlPath, p);
	}
	return p;
}

/** Test seam: forget cached loads. */
export function resetHeroStlCache(): void {
	meshPromises.clear();
}
