import { describe, expect, it } from "vitest";
import { flightDateOf, prevUtcDay } from "./flightDates";

describe("flightDateOf", () => {
	it("takes the UTC date component of an ISO start_date", () => {
		expect(flightDateOf("2001-09-11T12:46:40Z")).toBe("2001-09-11");
		expect(flightDateOf("2001-09-15T00:03:00.000Z")).toBe("2001-09-15");
	});
});

describe("prevUtcDay", () => {
	it("steps back one UTC day", () => {
		expect(prevUtcDay("2001-09-13")).toBe("2001-09-12");
	});

	it("crosses a month boundary", () => {
		expect(prevUtcDay("2001-10-01")).toBe("2001-09-30");
	});
});
