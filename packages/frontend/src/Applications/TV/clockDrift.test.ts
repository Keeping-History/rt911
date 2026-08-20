import { describe, expect, it } from "vitest";
import { calcSeekSeconds, resolveVirtualNowMs } from "./clockDrift";

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

describe("calcSeekSeconds", () => {
	it("computes seconds since the item start plus the jump offset", () => {
		const item = { start_date: "2001-09-11T12:30:00Z", jump: 5 };
		expect(calcSeekSeconds(item, Date.parse("2001-09-11T12:40:00Z"))).toBe(605);
	});

	it("treats a timezone-less Directus datetime as UTC", () => {
		const item = { start_date: "2001-09-11T12:30:00", jump: 0 };
		expect(calcSeekSeconds(item, Date.parse("2001-09-11T12:31:00Z"))).toBe(60);
	});

	it("clamps positions before the start of the file to 0", () => {
		const item = { start_date: "2001-09-11T12:30:00Z", jump: 0 };
		expect(calcSeekSeconds(item, Date.parse("2001-09-11T12:00:00Z"))).toBe(0);
	});
});
