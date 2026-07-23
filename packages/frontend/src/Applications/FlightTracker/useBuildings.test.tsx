import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBuildingsCache, useBuildings } from "./useBuildings";

afterEach(() => {
  cleanup();
  resetBuildingsCache();
  vi.restoreAllMocks();
});

const FC = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { height_m: 90, base_elevation_m: 2 }, geometry: { type: "Polygon", coordinates: [[[-74, 40.7], [-74, 40.71], [-73.99, 40.71], [-74, 40.7]]] } },
  ],
};

function Probe({ onData }: { onData: (n: number) => void }) {
  const b = useBuildings();
  onData(b.length);
  return null;
}

describe("useBuildings", () => {
  beforeEach(() => resetBuildingsCache());

  it("fetches, parses, and returns footprints", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => FC })));
    const seen: number[] = [];
    render(<Probe onData={(n) => seen.push(n)} />);
    await waitFor(() => expect(seen.at(-1)).toBe(1));
  });

  it("degrades to [] on fetch failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const seen: number[] = [];
    render(<Probe onData={(n) => seen.push(n)} />);
    await waitFor(() => expect(seen.at(-1)).toBe(0));
  });
});
