import { describe, expect, it } from "vitest";
import { windowSummary } from "./windowSummary";

describe("windowSummary", () => {
	it("renders a same-day window as one date and two times, in display time (UTC-4)", () => {
		expect(windowSummary({ start: "2001-09-11T12:40:00Z", end: "2001-09-11T13:30:00Z" })).toBe("9/11 08:40–09:30");
	});
	it("repeats the date when the window crosses midnight", () => {
		expect(windowSummary({ start: "2001-09-12T03:00:00Z", end: "2001-09-12T05:00:00Z" })).toBe("9/11 23:00–9/12 01:00");
	});
	it("says from / until for a single bound, and always for none", () => {
		expect(windowSummary({ start: "2001-09-11T12:40:00Z" })).toBe("from 9/11 08:40");
		expect(windowSummary({ end: "2001-09-11T13:30:00Z" })).toBe("until 9/11 09:30");
		expect(windowSummary({})).toBe("always");
	});
});
