import { describe, expect, it, vi } from "vitest";
import { Buildings3DLayer } from "./buildings3DLayer";

const MESH = { positions: new Float32Array([0, 0, 0, 1]), normals: new Float32Array([0, 0, 1]), vertexCount: 1 };

describe("Buildings3DLayer", () => {
  it("is a 3d custom layer, hidden by default", () => {
    const layer = new Buildings3DLayer();
    expect(layer.type).toBe("custom");
    expect(layer.renderingMode).toBe("3d");
    expect(layer.visible).toBe(false);
    expect(layer.id).toBe("buildings-3d");
  });

  it("setVisible flips state and repaints only on change", () => {
    const layer = new Buildings3DLayer();
    const map = { triggerRepaint: vi.fn() };
    (layer as unknown as { map: unknown }).map = map;
    layer.setVisible(true);
    layer.setVisible(true);
    expect(layer.visible).toBe(true);
    expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
  });

  it("defers meshes registered before GL is ready", () => {
    const layer = new Buildings3DLayer();
    layer.setMesh("footprints", MESH);
    expect(layer.hasMesh("footprints")).toBe(true);
  });

  it("setColor requests a repaint", () => {
    const layer = new Buildings3DLayer();
    const map = { triggerRepaint: vi.fn() };
    (layer as unknown as { map: unknown }).map = map;
    layer.setColor([0.1, 0.2, 0.3]);
    expect(map.triggerRepaint).toHaveBeenCalled();
  });
});
