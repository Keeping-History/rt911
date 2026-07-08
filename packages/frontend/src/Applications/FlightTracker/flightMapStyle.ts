import type { StyleSpecification } from "maplibre-gl";

// A monochrome, period-appropriate basemap style for the Mac OS 8 desktop: an
// off-white "paper" background, subtle land fill, thin gray country borders and
// thinner state borders, muted lakes. No labels. The vector source is a
// self-hosted PMTiles archive read via the pmtiles:// protocol (registered in
// FlightMap). The `background` layer is independent of the tiles, so if the
// PMTiles fails to load the map still renders (planes draw on the paper).
//
// Source-layer names (land/countries/states/lakes) are the contract with the
// basemap build script (scripts/build-basemap.md).
export function buildBasemapStyle(basemapUrl: string): StyleSpecification {
	return {
		version: 8,
		glyphs: undefined,
		sources: {
			basemap: { type: "vector", url: `pmtiles://${basemapUrl}` },
		},
		layers: [
			{ id: "background", type: "background", paint: { "background-color": "#efe9dd" } },
			{ id: "land", type: "fill", source: "basemap", "source-layer": "land",
				paint: { "fill-color": "#e3ddcf" } },
			{ id: "lakes", type: "fill", source: "basemap", "source-layer": "lakes",
				paint: { "fill-color": "#d7d3c6" } },
			{ id: "countries", type: "line", source: "basemap", "source-layer": "countries",
				paint: { "line-color": "#8a8574", "line-width": 0.8 } },
			{ id: "states", type: "line", source: "basemap", "source-layer": "states",
				paint: { "line-color": "#b3ad9c", "line-width": 0.4 } },
		],
	};
}
