import { describe, expect, it } from "vitest";
import { buildSphereMesh } from "./plane3dMesh";
import { PIXEL_BLOCK_PX, Planes3DLayer, pixelBufferSize } from "./planes3DLayer";

// The GL surface needs a real context (covered by eye in the browser); what's
// testable in jsdom is the config plumbing that lets one class back both the
// aircraft layer and the 3D replay-trail-sphere layer.
describe("Planes3DLayer config", () => {
	it("defaults to the aircraft layer (id, opaque)", () => {
		const layer = new Planes3DLayer();
		expect(layer.id).toBe("planes-3d-model");
		expect(layer.opacity).toBe(1);
	});

	it("accepts id, mesh builder and opacity so replay trails can be a translucent sibling", () => {
		const layer = new Planes3DLayer({
			id: "replay-trails-3d-model",
			buildMesh: () => buildSphereMesh(),
			opacity: 0.4,
		});
		expect(layer.id).toBe("replay-trails-3d-model");
		expect(layer.opacity).toBe(0.4);
	});
});

// Radar mode renders the meshes into a low-res offscreen buffer and
// nearest-neighbour upscales, so the aircraft read as 8-bit like the 2D icons.
describe("Planes3DLayer pixelation", () => {
	it("is off by default and toggles via setPixelate", () => {
		const layer = new Planes3DLayer();
		expect(layer.pixelate).toBe(false);
		layer.setPixelate(true);
		expect(layer.pixelate).toBe(true);
		layer.setPixelate(false);
		expect(layer.pixelate).toBe(false);
	});
});

describe("pixelBufferSize", () => {
	it("divides the drawing buffer into whole blocks, rounding up", () => {
		// A 4px block over an 800x600 buffer → 200x150 low-res target.
		expect(pixelBufferSize(800, 600, 4)).toEqual({ width: 200, height: 150 });
		// Non-multiples round up so the whole canvas is covered.
		expect(pixelBufferSize(801, 599, 4)).toEqual({ width: 201, height: 150 });
	});

	it("never collapses to a zero-sized buffer", () => {
		// Pre-layout / hidden canvas reports 0; a 0-dim texture is a GL error.
		expect(pixelBufferSize(0, 0, PIXEL_BLOCK_PX)).toEqual({ width: 1, height: 1 });
	});

	it("larger blocks yield a coarser buffer (chunkier pixels)", () => {
		expect(pixelBufferSize(800, 600, 8).width).toBeLessThan(
			pixelBufferSize(800, 600, 4).width,
		);
	});
});
