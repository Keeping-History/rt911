import { afterEach, describe, expect, it, vi } from "vitest";
import {
	familyForAircraftType,
	loadAircraftMesh,
	parseBinaryStl,
	resetAircraftMeshCache,
} from "./aircraftModels";

afterEach(() => {
	resetAircraftMeshCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("familyForAircraftType", () => {
	// Real strings from flight_tracks.aircraft_type (spot checks across all
	// 86 distinct values as of 2026-07).
	it.each([
		["Boeing 737-3H4", "b737"],
		["Boeing 737-824", "b737"],
		["Boeing 757-223", "b757"],
		["Boeing 767-223ER", "b767"],
		["Boeing 777-232", "b777"],
		["Boeing 727-2S7", "b727"],
		["Boeing 717-200", "md80"],
		["Douglas DC-9", "md80"],
		["Douglas DC9-15", "md80"],
		["Mcdonnell Douglas DC-9-81(MD-81)", "md80"],
		["Mcdonnell Douglas Aircraft Co MD 83", "md80"],
		["Mcdonnell Douglas MD-90-30", "md80"],
		["Douglas DC-10-40", "dc10"],
		["Mcdonnell-Douglas DC-10-30", "dc10"],
		["Mcdonnell Douglas MD-11", "dc10"],
		["Airbus Industrie A-319-114", "a319"],
		["Airbus Industrie A320-212", "a320"],
		["Canadair CL-600-2B19", "crj"],
		["Embraer EMB-135LR", "erj"],
		["Aerospatiale/Aeritalia ATR 42-300", "atr"],
		["Short Bros SD3-60", "atr"],
		["Grumman G-1159", "bizjet"],
		["Gulfstream Aerospace G1159B", "bizjet"],
		["Cessna 650", "bizjet"],
		["Aero Commander 690A", "bizjet"],
		["Beech E-90", "bizjet"],
		["Mitsubishi MU-2B-35", "bizjet"],
		["Douglas C-47A", "dc3"],
		["Douglas DC-7BF", "dc3"],
	] as const)("%s → %s", (type, family) => {
		expect(familyForAircraftType(type)).toBe(family);
	});

	it("falls back to generic for null/unknown types", () => {
		expect(familyForAircraftType(null)).toBe("generic");
		expect(familyForAircraftType(undefined)).toBe("generic");
		expect(familyForAircraftType("Wright Flyer")).toBe("generic");
	});
});

// A one-triangle binary STL fixture with a deliberately WRONG stored normal —
// the parser must recompute from winding.
function tinyStl(): ArrayBuffer {
	const buf = new ArrayBuffer(84 + 50);
	const view = new DataView(buf);
	view.setUint32(80, 1, true);
	const off = 84;
	// stored normal: garbage (points -x); triangle in the xy plane → true +z
	view.setFloat32(off, -1, true);
	const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0];
	for (let i = 0; i < 9; i++) view.setFloat32(off + 12 + i * 4, verts[i], true);
	return buf;
}

describe("parseBinaryStl", () => {
	it("reads triangles and recomputes normals from winding", () => {
		const mesh = parseBinaryStl(tinyStl());
		expect(mesh.vertexCount).toBe(3);
		expect([...mesh.positions.slice(0, 3)]).toEqual([0, 0, 0]);
		expect(mesh.normals[2]).toBeCloseTo(1, 6); // +z, not the stored -x junk
	});

	it("rejects wrong-size buffers", () => {
		expect(() => parseBinaryStl(new ArrayBuffer(83))).toThrow(/too short/);
		expect(() => parseBinaryStl(new ArrayBuffer(200))).toThrow(/size mismatch/);
	});
});

describe("loadAircraftMesh", () => {
	it("fetches once per family and caches the parsed mesh", async () => {
		const fetchMock = vi.fn<(url: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>>(async () => ({
			ok: true,
			arrayBuffer: async () => tinyStl(),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const a = await loadAircraftMesh("b767");
		const b = await loadAircraftMesh("b767");
		expect(a?.vertexCount).toBe(3);
		expect(b).toBe(a);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain("/b767.stl");
	});

	it("resolves null on failure instead of throwing (prism fallback)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
		expect(await loadAircraftMesh("dc3")).toBeNull();
	});
});
