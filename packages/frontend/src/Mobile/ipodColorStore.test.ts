import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_IPOD_COLOR,
	IPOD_COLORS,
	loadIpodColor,
	saveIpodColor,
} from "./ipodColorStore";

afterEach(() => window.localStorage.clear());

describe("ipodColorStore", () => {
	it("defaults to silver with nothing stored", () => {
		expect(loadIpodColor()).toBe(DEFAULT_IPOD_COLOR);
	});

	it("round-trips every valid color", () => {
		for (const color of IPOD_COLORS) {
			saveIpodColor(color);
			expect(loadIpodColor()).toBe(color);
		}
	});

	it("falls back to silver on a stale/invalid stored value", () => {
		// localStorage survives deploys — a removed color must not crash boot.
		window.localStorage.setItem("rt911IpodColor", "chartreuse");
		expect(loadIpodColor()).toBe("silver");
	});
});
