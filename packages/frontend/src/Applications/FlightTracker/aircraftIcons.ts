import type { AircraftFamily } from "./aircraftModels";

// Top-down silhouette SVGs for the 2D map mode, hosted alongside the 3D
// models (scripts/aircraft-models/make_icons.py bakes them from the same
// normalized STLs). Same lazy-cache shape as aircraftModels.loadAircraftMesh.

const ICON_BASE_URL =
	(import.meta.env.VITE_AIRCRAFT_MODELS_URL as string | undefined) ??
	"https://files.911realtime.org/maps/aircraft";

// One in-flight/settled promise per family; failures resolve null so a bad
// asset degrades to the generic icon rather than retry-storming.
const svgPromises = new Map<AircraftFamily, Promise<string | null>>();

/** Fetch a family's silhouette SVG text, cached forever (assets are immutable). */
export function loadAircraftIconSvg(family: AircraftFamily): Promise<string | null> {
	let p = svgPromises.get(family);
	if (!p) {
		p = fetch(`${ICON_BASE_URL}/icons/${family}.svg`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.text();
			})
			.catch((err: unknown) => {
				console.warn(`aircraft icon ${family} unavailable:`, err);
				return null;
			});
		svgPromises.set(family, p);
	}
	return p;
}

/** Test seam: forget cached loads (jsdom tests stub fetch per case). */
export function resetAircraftIconCache(): void {
	svgPromises.clear();
}
