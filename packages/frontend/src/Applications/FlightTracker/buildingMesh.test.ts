import { describe, expect, it } from "vitest";
import { buildFootprintMesh, ringIsCcwLngLat, type BuildingFootprint, placeHeroMesh, type HeroPlacement } from "./buildingMesh";
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
        // mercPerMeter is ~3.3e-8; float32 storage error at that magnitude is
        // ~2e-15, so 12 decimal places (tolerance 5e-13) is tight and still safe.
        expect(mesh.positions[i * 4 + 3]).toBeCloseTo(mercatorPerMeter(40.711), 12);
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

  it("scales wall normals for longitude/latitude degree ratio (cos(lat) correction)", () => {
    // Diamond around ~[-74.0, 40.705] with diagonal edges (each edge moves in
    // both lng and lat), so its wall normals expose the raw-degree-delta bug:
    // without the cos(lat) scaling, a diagonal edge that moves equally in lng
    // and lat degrees would incorrectly yield a normal with |nE| == |nN|.
    const DIAMOND: BuildingFootprint = {
      ring: [
        [-74.0, 40.704],
        [-73.999, 40.705],
        [-74.0, 40.706],
        [-74.001, 40.705],
      ],
      baseElevM: 0,
      heightM: 50,
    };
    const mesh = buildFootprintMesh([DIAMOND]);

    // Geographically-correct expected ratio for a 45-degree-in-degrees edge at
    // ~lat 40.705: longitude degrees are compressed by cos(lat), so the
    // outward normal's |east|/|north| ratio is 1 / cos(lat), not 1.
    const expectedRatio = 1 / Math.cos((40.705 * Math.PI) / 180);
    expect(expectedRatio).toBeCloseTo(1.318, 2);

    let foundMatchingNormal = false;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const nE = mesh.normals[i * 3];
      const nN = mesh.normals[i * 3 + 1];
      const nUp = mesh.normals[i * 3 + 2];

      // All normals (roof + wall) must be unit length.
      expect(Math.hypot(nE, nN, nUp)).toBeCloseTo(1, 5);

      // Only wall normals (nUp === 0) are diagonal-edge candidates here.
      if (nUp !== 0) continue;
      if (Math.abs(nE) < 1e-6 || Math.abs(nN) < 1e-6) continue;
      const ratio = Math.abs(nE) / Math.abs(nN);
      if (Math.abs(ratio - expectedRatio) < 0.03) {
        foundMatchingNormal = true;
      }
    }
    expect(foundMatchingNormal).toBe(true);
  });
});

// One flat-shaded triangle 1m north, 10m up, +Y north +Z up.
const TRI = {
  positions: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 10]),
  normals: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), // faces +east
  vertexCount: 3,
};

describe("placeHeroMesh", () => {
  const place: HeroPlacement = { lng: -74.0135, lat: 40.7127, bearingDeg: 0, scale: 2, baseElevM: 5 };

  it("keeps the vertex count and stride-4 positions", () => {
    const mesh = placeHeroMesh(TRI, place);
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.positions.length).toBe(3 * 4);
    expect(mesh.normals.length).toBe(3 * 3);
  });

  it("translates to the placement lng/lat + base elevation and scales height", () => {
    const mesh = placeHeroMesh(TRI, place);
    const [mx, my] = lngLatToMercator(place.lng, place.lat);
    // Vertex 0 is at local origin -> exactly the placement anchor, base elev.
    expect(mesh.positions[0]).toBeCloseTo(mx, 6);
    expect(mesh.positions[1]).toBeCloseTo(my, 6);
    expect(mesh.positions[2]).toBeCloseTo(5, 6); // baseElev + 0*scale
    // mercPerMeter is ~3.3e-8; float32 storage error at that magnitude is
    // ~2e-15, so 12 decimal places (tolerance 5e-13) is tight and still safe.
    expect(mesh.positions[3]).toBeCloseTo(mercatorPerMeter(place.lat), 12);
    // Vertex 2 is 10m up * scale 2 = 20m above base.
    expect(mesh.positions[2 * 4 + 2]).toBeCloseTo(5 + 20, 6);
  });

  it("rotates the north-offset vertex east under a 90 deg bearing", () => {
    // A 2m (or even a 2*scale m) offset is far too small to test reliably in
    // float32 mercator units: mercator x/y are ~0.29 in magnitude, so their
    // float32 quantization is ~1.7e-8, while a 2m east displacement in
    // mercator units is only ~6.6e-8 -- barely above the quantization floor.
    // Use a dedicated, large-offset fixture (10,000 m north) so the expected
    // displacement is orders of magnitude above the quantization noise, and
    // assert in meters (dividing out perM) rather than in raw mercator units.
    const FAR_NORTH = {
      positions: new Float32Array([0, 10000, 0]),
      normals: new Float32Array([1, 0, 0]),
      vertexCount: 1,
    };
    const mesh = placeHeroMesh(FAR_NORTH, { ...place, bearingDeg: 90, scale: 1 });
    const [mx, my] = lngLatToMercator(place.lng, place.lat);
    const perM = mercatorPerMeter(place.lat);
    // Local (0, 10000m north) at bearing 90 (clockwise from north) -> 10000m east.
    // This must FAIL if the rotation were a no-op (a no-op would leave the
    // vertex at ~0m east, far from the expected 10000m).
    const eastM = (mesh.positions[0] - mx) / perM;
    const northM = (my - mesh.positions[1]) / perM; // mercator y grows south
    expect(Math.abs(eastM - 10000)).toBeLessThan(5);
    expect(Math.abs(northM)).toBeLessThan(5);
  });
});
