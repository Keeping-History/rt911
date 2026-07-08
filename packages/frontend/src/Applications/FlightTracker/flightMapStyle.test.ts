import { describe, expect, it } from "vitest";
import { buildBasemapStyle } from "./flightMapStyle";

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
