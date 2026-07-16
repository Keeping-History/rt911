import { describe, expect, it } from "vitest";
import { TrackTube3DLayer } from "./trackTubeLayer";

// GL needs a real context (verified by eye in the browser); jsdom covers the
// config plumbing that lets one class draw the selected-flight tube AND the
// translucent unshaded trail ribbons.
describe("TrackTube3DLayer config", () => {
	it("defaults to the selected-flight tube (id, opaque, shaded)", () => {
		const layer = new TrackTube3DLayer();
		expect(layer.id).toBe("track-tube-3d");
		expect(layer.opacity).toBe(1);
		expect(layer.shaded).toBe(true);
	});

	it("accepts id, opacity and flat shading for the trail ribbons", () => {
		const layer = new TrackTube3DLayer({
			id: "trails-3d-model",
			opacity: 0.45,
			shaded: false,
		});
		expect(layer.id).toBe("trails-3d-model");
		expect(layer.opacity).toBe(0.45);
		expect(layer.shaded).toBe(false);
	});
});
