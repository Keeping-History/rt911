import { describe, expect, it } from "vitest";
import {
  centroidInExclude, excludeFootprints, manifestToPlacement, parseHeroManifest,
} from "./heroBuildings";
import type { BuildingFootprint } from "./buildingMesh";

const RAW = {
  heroes: [{
    id: "wtc-complex", stl_url: "maps/heroes/wtc-complex.stl",
    lng: -74.0134, lat: 40.7127, bearing_deg: 12, scale: 1.5, base_elev_m: 4,
    exclude: [-74.0155, 40.7108, -74.0110, 40.7140],
  }],
};

describe("parseHeroManifest", () => {
  it("maps snake_case manifest to typed entries", () => {
    const out = parseHeroManifest(RAW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "wtc-complex", stlPath: "maps/heroes/wtc-complex.stl",
      lng: -74.0134, lat: 40.7127, bearingDeg: 12, scale: 1.5, baseElevM: 4,
      exclude: [-74.0155, 40.7108, -74.0110, 40.7140],
    });
  });
  it("returns [] on malformed / missing", () => {
    expect(parseHeroManifest(null)).toEqual([]);
    expect(parseHeroManifest({ heroes: "nope" })).toEqual([]);
    expect(parseHeroManifest({ heroes: [{ id: "x" }] })).toEqual([]); // missing required numerics -> dropped
  });
});

describe("manifestToPlacement", () => {
  it("projects to HeroPlacement", () => {
    expect(manifestToPlacement(parseHeroManifest(RAW)[0])).toEqual({
      lng: -74.0134, lat: 40.7127, bearingDeg: 12, scale: 1.5, baseElevM: 4,
    });
  });
});

describe("centroidInExclude", () => {
  const bbox: [number, number, number, number] = [-74.0155, 40.7108, -74.0110, 40.7140];
  it("true when ring centroid is inside", () => {
    expect(centroidInExclude([[-74.0134, 40.7125], [-74.0130, 40.7128], [-74.0136, 40.7130]], bbox)).toBe(true);
  });
  it("false when centroid is outside", () => {
    expect(centroidInExclude([[-74.0090, 40.7125], [-74.0088, 40.7128], [-74.0092, 40.7130]], bbox)).toBe(false);
  });
});

describe("excludeFootprints", () => {
  const inside: BuildingFootprint = { ring: [[-74.0134, 40.7125], [-74.0130, 40.7128], [-74.0136, 40.7130]], baseElevM: 4, heightM: 417 };
  const outside: BuildingFootprint = { ring: [[-74.0090, 40.7125], [-74.0088, 40.7128], [-74.0092, 40.7130]], baseElevM: 4, heightM: 100 };
  const bbox: [number, number, number, number] = [-74.0155, 40.7108, -74.0110, 40.7140];
  it("drops footprints covered by an active bbox, keeps others", () => {
    expect(excludeFootprints([inside, outside], [bbox])).toEqual([outside]);
  });
  it("no-op when no active bboxes (fallback: everything kept)", () => {
    expect(excludeFootprints([inside, outside], [])).toEqual([inside, outside]);
  });
});
