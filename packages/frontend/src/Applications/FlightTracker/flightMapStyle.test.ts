import { describe, expect, it } from "vitest";
import { basemapPalette } from "../../lib/basemap/basemapStyles";
import { applyMapColors, trailColor, trailGradient } from "./flightMapStyle";

describe("trailColor", () => {
	it("keeps the original grays for classic light/dark", () => {
		expect(trailColor("classic", false)).toBe("#5a5a5a");
		expect(trailColor("classic", true)).toBe("#9a9aa6");
	});
	it("uses phosphor green for radar regardless of darkMap", () => {
		expect(trailColor("radar", false)).toBe("#39d353");
		expect(trailColor("radar", true)).toBe("#39d353");
	});
	it("uses near-white over day imagery and pale gray over night", () => {
		expect(trailColor("satellite", false)).toBe("#f2f2f2");
		expect(trailColor("satellite", true)).toBe("#cfd8e3");
	});
});

describe("trailGradient", () => {
	it("fades transparent→opaque in the style's trail color", () => {
		// classic dark trail #9a9aa6 → rgb 154,154,166
		const g = JSON.stringify(trailGradient("classic", true));
		expect(g).toContain("rgba(154,154,166,0)");
		expect(g).toContain("rgba(154,154,166,0.7)");
	});
});

describe("applyMapColors", () => {
	function recordingMap() {
		const paint: Record<string, Record<string, unknown>> = {};
		const layout: Record<string, Record<string, unknown>> = {};
		return {
			paint,
			layout,
			setPaintProperty(layerId: string, name: string, value: unknown) {
				(paint[layerId] ??= {})[name] = value;
			},
			setLayoutProperty(layerId: string, name: string, value: unknown) {
				(layout[layerId] ??= {})[name] = value;
			},
			setSky() {},
		};
	}

	it("applies palette, ground visibility, trail gradient, and replay-trail colors", () => {
		const map = recordingMap();
		applyMapColors(map, {
			mapStyle: "satellite", darkMap: true,
			pinColor: "#00aa00", notablePinColor: "#123456",
			terrain: false,
		});
		expect(map.paint.background["background-color"]).toBe(
			basemapPalette("satellite", true).background,
		);
		expect(map.layout["satellite-night"].visibility).toBe("visible");
		expect(map.layout.land.visibility).toBe("none");
		// satellite-night trail #cfd8e3 → rgb 207,216,227
		expect(JSON.stringify(map.paint["flight-trails"]["line-gradient"])).toContain("207,216,227");
		expect(map.paint["replay-trail-dots"]["circle-color"]).toBe("#00aa00");
		expect(map.paint["replay-trail-notable"]["circle-color"]).toBe("#123456");
		// Pin colors flow through icon rebuilds, not paint.
		expect(map.paint["flights-dots"]).toBeUndefined();
		expect(map.paint["flights-notable"]).toBeUndefined();
	});

	it("classic light matches the original paper behavior", () => {
		const map = recordingMap();
		applyMapColors(map, {
			mapStyle: "classic", darkMap: false,
			pinColor: "#3a3a3a", notablePinColor: "#c0202a",
			terrain: false,
		});
		expect(map.paint.background["background-color"]).toBe("#efe9dd");
		expect(map.layout.land.visibility).toBe("visible");
		expect(JSON.stringify(map.paint["flight-trails"]["line-gradient"])).toContain("90,90,90");
	});

	it("forwards the terrain flag to the shared basemap switch", () => {
		const map = recordingMap();
		applyMapColors(map, {
			mapStyle: "radar", darkMap: false,
			pinColor: "#ffd700", notablePinColor: "#ff4d4d",
			terrain: true,
		});
		expect(map.layout["hillshade-radar"].visibility).toBe("visible");
		expect(map.layout["hillshade-classic"].visibility).toBe("none");
	});
});
