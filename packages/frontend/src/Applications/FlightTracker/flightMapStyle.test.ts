import { describe, expect, it } from "vitest";
import {
	BASEMAP_PALETTES,
	TRAIL_COLORS,
	applyMapColors,
	buildBasemapStyle,
} from "./flightMapStyle";

describe("buildBasemapStyle", () => {
	const style = buildBasemapStyle("https://x.example/na.pmtiles");

	it("references the pmtiles url as a vector source", () => {
		const src = style.sources.basemap as { type: string; url: string };
		expect(src.type).toBe("vector");
		expect(src.url).toBe("pmtiles://https://x.example/na.pmtiles");
	});
	it("always includes a background layer so a failed basemap still renders", () => {
		const bg = style.layers.find((l) => l.id === "background");
		expect(bg?.type).toBe("background");
	});
	it("draws land, country, and state layers from the basemap source", () => {
		const ids = style.layers.map((l) => l.id);
		expect(ids).toEqual(expect.arrayContaining(["land", "countries", "states"]));
	});
	it("omits the glyphs key entirely (undefined value crashes maplibre 5 style validation)", () => {
		expect("glyphs" in buildBasemapStyle("https://x.example/na.pmtiles")).toBe(false);
	});
});

describe("buildBasemapStyle — themes", () => {
	it("defaults to the light (paper) palette", () => {
		const bg = buildBasemapStyle("https://x.example/na.pmtiles").layers.find(
			(l) => l.id === "background",
		) as { paint: { "background-color": string } };
		expect(bg.paint["background-color"]).toBe(BASEMAP_PALETTES.light.background);
	});

	it("uses the dark palette when asked", () => {
		const style = buildBasemapStyle("https://x.example/na.pmtiles", "dark");
		const bg = style.layers.find((l) => l.id === "background") as {
			paint: { "background-color": string };
		};
		const land = style.layers.find((l) => l.id === "land") as {
			paint: { "fill-color": string };
		};
		expect(bg.paint["background-color"]).toBe(BASEMAP_PALETTES.dark.background);
		expect(land.paint["fill-color"]).toBe(BASEMAP_PALETTES.dark.land);
	});
});

describe("applyMapColors", () => {
	function recordingMap() {
		const paint: Record<string, Record<string, unknown>> = {};
		return {
			paint,
			setPaintProperty(layerId: string, name: string, value: unknown) {
				(paint[layerId] ??= {})[name] = value;
			},
		};
	}

	it("applies the dark palette, themed trail color, and pin colors", () => {
		const map = recordingMap();
		applyMapColors(map, {
			darkMap: true,
			pinColor: "#00aa00",
			notablePinColor: "#123456",
		});
		expect(map.paint.background["background-color"]).toBe(
			BASEMAP_PALETTES.dark.background,
		);
		expect(map.paint.states["line-color"]).toBe(BASEMAP_PALETTES.dark.states);
		expect(map.paint["flight-trails"]["line-color"]).toBe(TRAIL_COLORS.dark);
		expect(map.paint["flights-dots"]["circle-color"]).toBe("#00aa00");
		expect(map.paint["flights-notable"]["circle-color"]).toBe("#123456");
	});

	it("applies the light palette when darkMap is off", () => {
		const map = recordingMap();
		applyMapColors(map, {
			darkMap: false,
			pinColor: "#3a3a3a",
			notablePinColor: "#c0202a",
		});
		expect(map.paint.background["background-color"]).toBe(
			BASEMAP_PALETTES.light.background,
		);
		expect(map.paint["flight-trails"]["line-color"]).toBe(TRAIL_COLORS.light);
	});
});
