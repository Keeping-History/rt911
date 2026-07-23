import { describe, expect, it } from "vitest";
import { buildFootprintMesh, ringIsCcwLngLat, type BuildingFootprint } from "./buildingMesh";
import { lngLatToMercator, mercatorPerMeter } from "./plane3dMesh";

// A unit square footprint around a NYC-ish point, CW on purpose to exercise
// orientation normalization.
const SQUARE: BuildingFootprint = {
  ring: [
    [-74.013, 40.711],
    [-74.013, 40.712],
    [-74.012, 40.712],
    [-74.012, 40.711],
  ],
  baseElevM: 3,
  heightM: 100,
};

describe("ringIsCcwLngLat", () => {
  it("detects winding", () => {
    expect(ringIsCcwLngLat([[0, 0], [1, 0], [1, 1], [0, 1]])).toBe(true); // CCW
    expect(ringIsCcwLngLat([[0, 0], [0, 1], [1, 1], [1, 0]])).toBe(false); // CW
  });
});

describe("buildFootprintMesh", () => {
  it("emits roof cap + wall quads with matching strides", () => {
    const mesh = buildFootprintMesh([SQUARE]);
    // roof: quad -> 2 tris -> 6 verts; walls: 4 edges * 2 tris * 3 verts = 24; total 30
    expect(mesh.vertexCount).toBe(30);
    expect(mesh.positions.length).toBe(30 * 4);
    expect(mesh.normals.length).toBe(30 * 3);
  });

  it("places roof vertices at base+height and walls span base..roof", () => {
    const mesh = buildFootprintMesh([SQUARE]);
    const elevs = new Set<number>();
    for (let i = 0; i < mesh.vertexCount; i++) elevs.add(mesh.positions[i * 4 + 2]);
    expect(elevs.has(3)).toBe(true); // base elevation present (wall bottoms)
    expect(elevs.has(103)).toBe(true); // base + height present (roof + wall tops)
  });

  it("bakes mercator xy + mercPerMeter from the ring's coordinates", () => {
    const mesh = buildFootprintMesh([SQUARE]);
    const [mx, my] = lngLatToMercator(-74.013, 40.711);
    // Some vertex must sit at that corner's mercator position.
    let found = false;
    for (let i = 0; i < mesh.vertexCount; i++) {
      // Float32Array has ~7 decimal digits precision; for 0.29 range that's ~1e-7.
      // Use 1e-6 tolerance to safely accommodate 32-bit storage rounding.
      if (Math.abs(mesh.positions[i * 4] - mx) < 1e-6 && Math.abs(mesh.positions[i * 4 + 1] - my) < 1e-6) {
        found = true;
        // mercPerMeter also stored at 32-bit, so use 6 decimal places (1e-6) precision
        expect(mesh.positions[i * 4 + 3]).toBeCloseTo(mercatorPerMeter(40.711), 6);
      }
    }
    expect(found).toBe(true);
  });

  it("roof normals point up", () => {
    const mesh = buildFootprintMesh([SQUARE]);
    // The first 6 vertices are the roof cap (see builder order); their normal is +up.
    for (let i = 0; i < 6; i++) {
      expect(mesh.normals[i * 3 + 2]).toBeCloseTo(1, 6);
    }
  });

  it("concatenates multiple buildings", () => {
    const mesh = buildFootprintMesh([SQUARE, SQUARE]);
    expect(mesh.vertexCount).toBe(60);
  });
});
