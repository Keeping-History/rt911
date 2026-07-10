import { describe, expect, it } from "vitest";
import {
	GROUND_STOP_END_MS,
	GROUND_STOP_START_MS,
	groundStopStatus,
	LIFTED_NOTICE_MS,
} from "./groundStop";

describe("ground stop constants", () => {
	it("starts at 9:26 a.m. EDT on September 11, 2001", () => {
		expect(GROUND_STOP_START_MS).toBe(Date.parse("2001-09-11T13:26:00.000Z"));
	});

	it("ends when airspace reopens at 11:00 a.m. EDT on September 13, 2001", () => {
		expect(GROUND_STOP_END_MS).toBe(Date.parse("2001-09-13T15:00:00.000Z"));
	});
});

describe("groundStopStatus", () => {
	it("is none before the order (app boot time, 8:40 a.m. EDT)", () => {
		expect(groundStopStatus(Date.parse("2001-09-11T12:40:00.000Z"))).toBe("none");
	});

	it("is none one millisecond before the order", () => {
		expect(groundStopStatus(GROUND_STOP_START_MS - 1)).toBe("none");
	});

	it("is active at the instant the order is issued", () => {
		expect(groundStopStatus(GROUND_STOP_START_MS)).toBe("active");
	});

	it("is active mid-stop (overnight September 12)", () => {
		expect(groundStopStatus(Date.parse("2001-09-12T06:00:00.000Z"))).toBe("active");
	});

	it("is active one millisecond before airspace reopens", () => {
		expect(groundStopStatus(GROUND_STOP_END_MS - 1)).toBe("active");
	});

	it("is lifted at the instant airspace reopens", () => {
		expect(groundStopStatus(GROUND_STOP_END_MS)).toBe("lifted");
	});

	it("is lifted one millisecond before the notice window closes", () => {
		expect(groundStopStatus(GROUND_STOP_END_MS + LIFTED_NOTICE_MS - 1)).toBe(
			"lifted",
		);
	});

	it("is none once the lifted notice window closes", () => {
		expect(groundStopStatus(GROUND_STOP_END_MS + LIFTED_NOTICE_MS)).toBe("none");
	});
});
