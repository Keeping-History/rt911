import { describe, expect, it } from "vitest";
import { resolveVirtualNowMs } from "./clockDrift";

describe("resolveVirtualNowMs", () => {
	it("returns the store time unchanged when no real time has elapsed", () => {
		const storeDateTime = "2001-09-11T12:40:00.000Z";
		const updatedAtMs = 1_000_000;
		expect(resolveVirtualNowMs(storeDateTime, updatedAtMs, updatedAtMs)).toBe(
			new Date(storeDateTime).getTime(),
		);
	});

	it("adds real time elapsed since the store's dateTime last changed", () => {
		const storeDateTime = "2001-09-11T12:40:00.000Z";
		const updatedAtMs = 1_000_000;
		const realNowMs = updatedAtMs + 35_134;
		expect(resolveVirtualNowMs(storeDateTime, updatedAtMs, realNowMs)).toBe(
			new Date(storeDateTime).getTime() + 35_134,
		);
	});
});
