import { describe, expect, it } from "vitest";
import { buildSphereMesh } from "./plane3dMesh";
import { Planes3DLayer } from "./planes3DLayer";

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
