import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHeroStl, resetHeroStlCache } from "./buildingModels";

// Minimal valid binary STL: 80-byte header + uint32 count(1) + 50-byte triangle.
function fakeStl(): ArrayBuffer {
  const buf = new ArrayBuffer(84 + 50);
  const dv = new DataView(buf);
  dv.setUint32(80, 1, true);
  // one triangle at (0,0,0),(1,0,0),(0,1,0); normal slot skipped by parser
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  for (let i = 0; i < 9; i++) dv.setFloat32(84 + 12 + i * 4, verts[i], true);
  return buf;
}

afterEach(() => { resetHeroStlCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("loadHeroStl", () => {
  it("fetches + parses a binary STL into a mesh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => fakeStl() })));
    const mesh = await loadHeroStl("maps/heroes/x.stl");
    expect(mesh).not.toBeNull();
    expect(mesh?.vertexCount).toBe(3);
  });
  it("returns null on fetch failure (graceful)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    expect(await loadHeroStl("maps/heroes/missing.stl")).toBeNull();
  });
  it("caches by path (one fetch for repeated loads)", async () => {
    const f = vi.fn(async () => ({ ok: true, arrayBuffer: async () => fakeStl() }));
    vi.stubGlobal("fetch", f);
    await loadHeroStl("maps/heroes/x.stl");
    await loadHeroStl("maps/heroes/x.stl");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
