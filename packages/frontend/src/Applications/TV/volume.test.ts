import { describe, expect, it } from "vitest";
import { resolveGridVolume } from "./volume";

describe("resolveGridVolume", () => {
	it("defaults an unset per-player volume to 1, capped by the limit", () => {
		expect(resolveGridVolume(undefined, 1, false)).toBe(1);
		expect(resolveGridVolume(undefined, 0.5, false)).toBe(0.5);
	});

	it("uses the per-player volume when it is below the limit", () => {
		expect(resolveGridVolume(0.3, 0.8, false)).toBe(0.3);
	});

	it("caps the per-player volume at the limit", () => {
		expect(resolveGridVolume(0.9, 0.4, false)).toBe(0.4);
	});

	it("returns 0 when muted regardless of volumes", () => {
		expect(resolveGridVolume(1, 1, true)).toBe(0);
		expect(resolveGridVolume(0.5, 0.5, true)).toBe(0);
	});

	it("returns 0 when the limit is 0", () => {
		expect(resolveGridVolume(1, 0, false)).toBe(0);
	});
});
