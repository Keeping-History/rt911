import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHeroBuildingsCache, useHeroBuildings } from "./useHeroBuildings";

afterEach(() => {
  cleanup();
  resetHeroBuildingsCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FC = {
  heroes: [
    {
      id: "wtc-complex",
      stl_url: "maps/heroes/x.stl",
      lng: -74.01,
      lat: 40.71,
      bearing_deg: 0,
      scale: 1,
      base_elev_m: 4,
      exclude: [-74.02, 40.7, -74.0, 40.72],
    },
  ],
};

function Probe({ onN }: { onN: (n: number) => void }) {
  onN(useHeroBuildings().length);
  return null;
}

describe("useHeroBuildings", () => {
  beforeEach(() => resetHeroBuildingsCache());
  it("fetches + parses the manifest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => FC })));
    const seen: number[] = [];
    render(<Probe onN={(n) => seen.push(n)} />);
    await waitFor(() => expect(seen.at(-1)).toBe(1));
  });
  it("degrades to [] on failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const seen: number[] = [];
    render(<Probe onN={(n) => seen.push(n)} />);
    await waitFor(() => expect(seen.at(-1)).toBe(0));
  });
});
