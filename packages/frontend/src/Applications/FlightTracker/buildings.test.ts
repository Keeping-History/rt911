import { describe, expect, it } from "vitest";
import {
  BUILDINGS_MIN_ZOOM,
  buildingColorRgb,
  buildingsVisibleAtZoom,
  parseBuildingsGeoJSON,
} from "./buildings";

describe("buildingsVisibleAtZoom", () => {
  it("hides below the threshold, shows at/above it", () => {
    expect(buildingsVisibleAtZoom(BUILDINGS_MIN_ZOOM - 0.01)).toBe(false);
    expect(buildingsVisibleAtZoom(BUILDINGS_MIN_ZOOM)).toBe(true);
    expect(buildingsVisibleAtZoom(BUILDINGS_MIN_ZOOM + 3)).toBe(true);
  });
});

describe("buildingColorRgb", () => {
  it("returns 0..1 rgb tuples that differ by tone", () => {
    const light = buildingColorRgb("classic", false);
    const dark = buildingColorRgb("classic", true);
    for (const c of [...light, ...dark]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(light).not.toEqual(dark);
  });
  it("treats radar as its own tone", () => {
    expect(buildingColorRgb("radar", false)).toEqual(buildingColorRgb("radar", true));
  });
});

describe("parseBuildingsGeoJSON", () => {
  const fc = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { height_m: 120, base_elevation_m: 4 },
        geometry: { type: "Polygon", coordinates: [[[-74, 40.7], [-74, 40.71], [-73.99, 40.71], [-74, 40.7]]] },
      },
      {
        type: "Feature",
        properties: { height_m: 50 }, // missing base_elevation_m -> defaults 0
        geometry: { type: "Polygon", coordinates: [[[-74, 40.7], [-74, 40.71], [-73.99, 40.71]]] },
      },
    ],
  };

  it("maps polygons to footprints with height/base", () => {
    const out = parseBuildingsGeoJSON(fc);
    expect(out).toHaveLength(2);
    expect(out[0].heightM).toBe(120);
    expect(out[0].baseElevM).toBe(4);
    expect(out[0].ring[0]).toEqual([-74, 40.7]);
    expect(out[1].baseElevM).toBe(0);
  });

  it("skips features without a positive height", () => {
    const out = parseBuildingsGeoJSON({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { height_m: 0 }, geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1]]] } }],
    });
    expect(out).toHaveLength(0);
  });

  it("returns [] on malformed input", () => {
    expect(parseBuildingsGeoJSON(null)).toEqual([]);
    expect(parseBuildingsGeoJSON({ features: "nope" })).toEqual([]);
  });
});
