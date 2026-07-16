import { describe, expect, it } from "vitest";
import {
	BASEMAP_URLS,
	type BasemapStyleId,
	applyBasemapStyle,
	basemapPalette,
	buildBasemapStyle,
	effectiveTone,
	groundVisibility,
	hillshadePalette,
	hillshadeVisibility,
	normalizeBasemapStyle,
	skyFor,
} from "./basemapStyles";

const URLS = {
	vector: "https://x.example/na.pmtiles",
	satelliteDay: "https://x.example/day.pmtiles",
	satelliteNight: "https://x.example/night.pmtiles",
};

const ALL_STYLES: BasemapStyleId[] = ["classic", "radar", "satellite"];

describe("effectiveTone", () => {
	it("follows darkMap for classic and satellite, forces dark for radar", () => {
		expect(effectiveTone("classic", false)).toBe("light");
		expect(effectiveTone("classic", true)).toBe("dark");
		expect(effectiveTone("satellite", false)).toBe("light");
		expect(effectiveTone("satellite", true)).toBe("dark");
		expect(effectiveTone("radar", false)).toBe("dark");
		expect(effectiveTone("radar", true)).toBe("dark");
	});
});

describe("normalizeBasemapStyle", () => {
	it("passes valid ids through and falls back to classic otherwise", () => {
		expect(normalizeBasemapStyle("radar")).toBe("radar");
		expect(normalizeBasemapStyle("satellite")).toBe("satellite");
		expect(normalizeBasemapStyle("classic")).toBe("classic");
		expect(normalizeBasemapStyle("sepia")).toBe("classic"); // future rename safety
		expect(normalizeBasemapStyle(undefined)).toBe("classic");
		expect(normalizeBasemapStyle(42)).toBe("classic");
	});
});

describe("BASEMAP_URLS", () => {
	it("defaults to the files.911realtime.org maps/ prefix", () => {
		expect(BASEMAP_URLS.vector).toContain("/maps/world-basemap.pmtiles");
		expect(BASEMAP_URLS.satelliteDay).toContain("/maps/na-satellite-day.pmtiles");
		expect(BASEMAP_URLS.satelliteNight).toContain("/maps/na-satellite-night.pmtiles");
	});
});

describe("buildBasemapStyle — superset structure", () => {
	const style = buildBasemapStyle(URLS, "classic", false);

	it("contains the vector source and both raster sources", () => {
		const basemap = style.sources.basemap as { type: string; url: string };
		const day = style.sources["satellite-day"] as {
			type: string; url: string; bounds: number[];
		};
		const night = style.sources["satellite-night"] as { type: string; url: string };
		expect(basemap.type).toBe("vector");
		expect(basemap.url).toBe("pmtiles://https://x.example/na.pmtiles");
		expect(day.type).toBe("raster");
		expect(day.url).toBe("pmtiles://https://x.example/day.pmtiles");
		expect("maxzoom" in day).toBe(false);
		expect(day.bounds).toEqual([-150, 18, -65, 65]);
		expect(night.type).toBe("raster");
	});

	it("orders layers background → rasters → land/lakes → countries/states", () => {
		expect(style.layers.map((l) => l.id)).toEqual([
			"background", "satellite-day", "satellite-night",
			"land", "lakes", "countries", "states",
		]);
	});

	it("always includes a background layer so a failed basemap still renders", () => {
		expect(style.layers.find((l) => l.id === "background")?.type).toBe("background");
	});

	it("sets a defined glyphs URL (an undefined value crashes maplibre 5 style validation)", () => {
		// Cluster-count labels need glyph PBFs (issue #222). Must never be
		// undefined — that's the maplibre-5 validation crash the old
		// omit-the-key rule guarded against.
		expect(style.glyphs).toBe(
			"https://files.911realtime.org/maps/fonts/{fontstack}/{range}.pbf",
		);
	});
});

// Exactly one ground visible for every (style, darkMap) combination.
describe("groundVisibility matrix", () => {
	it.each([
		["classic", false, { vector: true, satelliteDay: false, satelliteNight: false }],
		["classic", true, { vector: true, satelliteDay: false, satelliteNight: false }],
		["radar", false, { vector: true, satelliteDay: false, satelliteNight: false }],
		["radar", true, { vector: true, satelliteDay: false, satelliteNight: false }],
		["satellite", false, { vector: false, satelliteDay: true, satelliteNight: false }],
		["satellite", true, { vector: false, satelliteDay: false, satelliteNight: true }],
	] as const)("%s darkMap=%s", (styleId, dark, expected) => {
		expect(groundVisibility(styleId, dark)).toEqual(expected);
	});

	it("buildBasemapStyle bakes the same visibility into layer layout", () => {
		for (const styleId of ALL_STYLES) {
			for (const dark of [false, true]) {
				const style = buildBasemapStyle(URLS, styleId, dark);
				const vis = (id: string) =>
					(style.layers.find((l) => l.id === id) as { layout?: { visibility?: string } })
						.layout?.visibility ?? "visible";
				const g = groundVisibility(styleId, dark);
				expect(vis("land")).toBe(g.vector ? "visible" : "none");
				expect(vis("lakes")).toBe(g.vector ? "visible" : "none");
				expect(vis("satellite-day")).toBe(g.satelliteDay ? "visible" : "none");
				expect(vis("satellite-night")).toBe(g.satelliteNight ? "visible" : "none");
			}
		}
	});
});

describe("basemapPalette", () => {
	it("classic palettes are the original paper and slate values", () => {
		expect(basemapPalette("classic", false).background).toBe("#efe9dd");
		expect(basemapPalette("classic", true).background).toBe("#1c1c22");
	});
	it("radar returns the same phosphor palette regardless of darkMap", () => {
		expect(basemapPalette("radar", false)).toEqual(basemapPalette("radar", true));
		expect(basemapPalette("radar", true).background).toBe("#041004");
	});
	it("satellite borders are translucent white over imagery", () => {
		expect(basemapPalette("satellite", false).countries).toContain("rgba(255,255,255");
		expect(basemapPalette("satellite", true).countries).toContain("rgba(255,255,255");
	});
});

describe("applyBasemapStyle", () => {
	function recordingMap() {
		const paint: Record<string, Record<string, unknown>> = {};
		const layout: Record<string, Record<string, unknown>> = {};
		const skies: unknown[] = [];
		return {
			paint,
			layout,
			skies,
			setPaintProperty(layerId: string, name: string, value: unknown) {
				(paint[layerId] ??= {})[name] = value;
			},
			setLayoutProperty(layerId: string, name: string, value: unknown) {
				(layout[layerId] ??= {})[name] = value;
			},
			setSky(sky: unknown) {
				skies.push(sky);
			},
		};
	}

	it("switching to satellite-night hides the vector ground and shows the night raster", () => {
		const map = recordingMap();
		applyBasemapStyle(map, "satellite", true);
		expect(map.layout["satellite-night"].visibility).toBe("visible");
		expect(map.layout["satellite-day"].visibility).toBe("none");
		expect(map.layout.land.visibility).toBe("none");
		expect(map.layout.lakes.visibility).toBe("none");
		expect(map.paint.background["background-color"]).toBe(
			basemapPalette("satellite", true).background,
		);
	});

	it("switching back to classic restores the vector ground and hides both rasters", () => {
		const map = recordingMap();
		applyBasemapStyle(map, "classic", false);
		expect(map.layout.land.visibility).toBe("visible");
		expect(map.layout["satellite-day"].visibility).toBe("none");
		expect(map.layout["satellite-night"].visibility).toBe("none");
		expect(map.paint.states["line-color"]).toBe(basemapPalette("classic", false).states);
	});

	it("radar applies the phosphor palette", () => {
		const map = recordingMap();
		applyBasemapStyle(map, "radar", false);
		expect(map.paint.background["background-color"]).toBe("#041004");
		expect(map.layout.land.visibility).toBe("visible");
	});

	it("re-applies the style's sky on a live switch", () => {
		const map = recordingMap();
		applyBasemapStyle(map, "radar", false);
		expect(map.skies.at(-1)).toEqual(skyFor("radar", false));
	});
});

describe("sky (issue #221)", () => {
	it("every style provides a complete sky spec (colors are hand-tuned, not pinned)", () => {
		// Exact colors/blends are living tuning values — tests guard the
		// STRUCTURE: all keys defined (an undefined value crashes maplibre 5
		// style validation) and the atmosphere halo expression well-formed.
		for (const style of ALL_STYLES) {
			for (const dark of [false, true]) {
				const sky = skyFor(style, dark);
				expect(typeof sky["sky-color"]).toBe("string");
				expect(typeof sky["horizon-color"]).toBe("string");
				expect(typeof sky["sky-horizon-blend"]).toBe("number");
				expect(typeof sky["horizon-fog-blend"]).toBe("number");
				expect(Array.isArray(sky["atmosphere-blend"])).toBe(true);
				expect(sky["atmosphere-blend"][0]).toBe("interpolate");
			}
		}
	});

	it("radar ignores darkMap and dark tones differ from the light sky", () => {
		expect(skyFor("radar", true)).toEqual(skyFor("radar", false));
		expect(skyFor("classic", true)["sky-color"]).not.toBe(skyFor("classic", false)["sky-color"]);
		expect(skyFor("satellite", true)["sky-color"]).not.toBe(
			skyFor("satellite", false)["sky-color"],
		);
	});

	it("buildBasemapStyle embeds the style-level sky", () => {
		expect(buildBasemapStyle(URLS, "classic", false).sky).toEqual(skyFor("classic", false));
		expect(buildBasemapStyle(URLS, "satellite", true).sky).toEqual(skyFor("satellite", true));
	});
});

describe("hillshadePalette", () => {
	it("every style×tone provides a complete palette (colors are hand-tuned, not pinned)", () => {
		for (const style of ALL_STYLES) {
			for (const dark of [false, true]) {
				const p = hillshadePalette(style, dark);
				expect(typeof p.shadow).toBe("string");
				expect(typeof p.highlight).toBe("string");
				expect(typeof p.accent).toBe("string");
				expect(p.exaggeration).toBeGreaterThan(0);
				expect(p.exaggeration).toBeLessThanOrEqual(1);
			}
		}
	});
	it("radar ignores darkMap and its shading stays in the phosphor family", () => {
		expect(hillshadePalette("radar", true)).toEqual(hillshadePalette("radar", false));
	});
	it("classic tones differ so relief reads on both paper and slate", () => {
		expect(hillshadePalette("classic", true)).not.toEqual(hillshadePalette("classic", false));
	});
});

describe("hillshadeVisibility", () => {
	it("terrain off hides every hillshade layer", () => {
		for (const style of ALL_STYLES) {
			expect(hillshadeVisibility(style, false)).toEqual({
				classic: false, radar: false, satellite: false,
			});
		}
	});
	it("terrain on shows exactly the active style's layer", () => {
		expect(hillshadeVisibility("classic", true)).toEqual({
			classic: true, radar: false, satellite: false,
		});
		expect(hillshadeVisibility("radar", true)).toEqual({
			classic: false, radar: true, satellite: false,
		});
		expect(hillshadeVisibility("satellite", true)).toEqual({
			classic: false, radar: false, satellite: true,
		});
	});
});
