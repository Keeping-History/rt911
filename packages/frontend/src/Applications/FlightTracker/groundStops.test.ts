import { describe, expect, it } from "vitest";
import { groundStopAt } from "./groundStops";

const details = {
	ground_stops: [
		{ code: "SRQ", name: "Sarasota-Bradenton International Airport", start: "2001-09-11T04:00:00Z", end: "2001-09-11T13:54:00Z" },
		{ code: "BAD", name: "Barksdale Air Force Base", start: "2001-09-11T15:45:00Z", end: "2001-09-11T17:37:00Z" },
	],
};

describe("groundStopAt", () => {
	it("returns the stop covering the instant", () => {
		expect(groundStopAt(details, Date.parse("2001-09-11T16:00:00Z"))?.code).toBe("BAD");
	});
	it("bounds are inclusive", () => {
		expect(groundStopAt(details, Date.parse("2001-09-11T15:45:00Z"))?.code).toBe("BAD");
		expect(groundStopAt(details, Date.parse("2001-09-11T17:37:00Z"))?.code).toBe("BAD");
	});
	it("null while airborne, on missing data, and on malformed stops", () => {
		expect(groundStopAt(details, Date.parse("2001-09-11T14:30:00Z"))).toBeNull();
		expect(groundStopAt(null, 0)).toBeNull();
		expect(groundStopAt({}, 0)).toBeNull();
		expect(groundStopAt({ ground_stops: [{ code: "X", name: "X", start: "bad", end: "bad" }] }, 0)).toBeNull();
	});
});
