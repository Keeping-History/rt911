import { describe, expect, it } from "vitest";
import {
	BASEMAP_PALETTES,
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
		// Trails fade via a themed line-gradient (dark #9a9aa6 → rgb 154,154,166).
		expect(JSON.stringify(map.paint["flight-trails"]["line-gradient"])).toContain("154,154,166");
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
		// Light trail gradient (#5a5a5a → rgb 90,90,90).
		expect(JSON.stringify(map.paint["flight-trails"]["line-gradient"])).toContain("90,90,90");
	});
});

describe("applyMapColors ghost layers", () => {
	it("recolors the ghost layers with the pin colors", () => {
		const calls: Array<[string, string, unknown]> = [];
		const map = {
			setPaintProperty: (l: string, n: string, v: unknown) =>
				calls.push([l, n, v]),
		};
		applyMapColors(map, {
			darkMap: false,
			pinColor: "#112233",
			notablePinColor: "#445566",
		});
		expect(calls).toContainEqual(["ghost-dots", "circle-color", "#112233"]);
		expect(calls).toContainEqual(["ghost-notable", "circle-color", "#445566"]);
	});
});
