import { describe, expect, it } from "vitest";
import {
	CAMERA_MODES,
	cameraPose,
	DEFAULT_CAMERA_MODE,
	MAX_FOLLOW_PITCH,
	normalizeCameraMode,
	offsetLngLat,
} from "./flightCamera";

describe("normalizeCameraMode", () => {
	it("keeps the three known modes", () => {
		expect(normalizeCameraMode("track")).toBe("track");
		expect(normalizeCameraMode("cockpit")).toBe("cockpit");
		expect(normalizeCameraMode("highlight")).toBe("highlight");
	});
	it("falls back to the default for unknown/legacy values", () => {
		expect(normalizeCameraMode("orbit")).toBe(DEFAULT_CAMERA_MODE);
		expect(normalizeCameraMode(undefined)).toBe(DEFAULT_CAMERA_MODE);
		expect(normalizeCameraMode(null)).toBe("track");
	});
	it("exposes exactly the three modes", () => {
		expect(CAMERA_MODES).toEqual(["track", "cockpit", "highlight"]);
	});
});

describe("offsetLngLat", () => {
	it("moves north for heading 0", () => {
		const [lon, lat] = offsetLngLat(-74, 40, 0, 11.0574);
		expect(lon).toBeCloseTo(-74, 6);
		expect(lat).toBeCloseTo(40.1, 4); // 11.0574 km ≈ 0.1° lat
	});
	it("moves east for heading 90, expanding longitude by 1/cos(lat)", () => {
		const [lon, lat] = offsetLngLat(-74, 60, 90, 11.132);
		expect(lat).toBeCloseTo(60, 6);
		// 11.132 km east at 60°N ≈ 0.1° / cos(60°) = 0.2° of longitude.
		expect(lon).toBeCloseTo(-73.8, 3);
	});
});

describe("cameraPose", () => {
	const target = { lon: -74, lat: 40, headingDeg: 90 };

	it("track recenters top-down, north-up, keeping the current zoom", () => {
		const pose = cameraPose("track", target, 7.3);
		expect(pose.center).toEqual([-74, 40]);
		expect(pose.zoom).toBe(7.3);
		expect(pose.pitch).toBe(0);
		expect(pose.bearing).toBe(0);
	});

	it("highlight tilts, faces the heading, and frames ahead of the plane", () => {
		const pose = cameraPose("highlight", target, 7.3);
		expect(pose.bearing).toBe(90);
		expect(pose.pitch).toBeGreaterThan(0);
		expect(pose.pitch).toBeLessThan(MAX_FOLLOW_PITCH);
		expect(pose.zoom).toBeGreaterThan(7.3); // fixed closer framing, not the current zoom
		// heading east → look-point shifted east of the plane.
		expect(pose.center[0]).toBeGreaterThan(-74);
		expect(pose.center[1]).toBeCloseTo(40, 4);
	});

	it("cockpit is steeper and closer than highlight", () => {
		const highlight = cameraPose("highlight", target, 7.3);
		const cockpit = cameraPose("cockpit", target, 7.3);
		expect(cockpit.bearing).toBe(90);
		expect(cockpit.pitch).toBeGreaterThan(highlight.pitch);
		expect(cockpit.pitch).toBeLessThanOrEqual(MAX_FOLLOW_PITCH);
		expect(cockpit.zoom).toBeGreaterThan(highlight.zoom);
		// Look-point pushed further ahead than highlight (camera sits ~at the plane).
		expect(cockpit.center[0]).toBeGreaterThan(highlight.center[0]);
	});
});
