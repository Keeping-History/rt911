import { describe, expect, it } from "vitest";
import { flightDateOf, trackUrl } from "./useFlightTrack";

describe("flightDateOf", () => {
	it("takes the UTC date component of an ISO start_date", () => {
		expect(flightDateOf("2001-09-11T12:46:40Z")).toBe("2001-09-11");
		expect(flightDateOf("2001-09-15T00:03:00.000Z")).toBe("2001-09-15");
	});
});

describe("trackUrl", () => {
	it("builds a filtered flight_tracks query against VITE_DIRECTUS_URL", () => {
		const url = trackUrl("AA11", "2001-09-11");
		expect(url).toContain("/items/flight_tracks?");
		expect(url).toContain("filter%5Bflight%5D%5B_eq%5D=AA11");
		expect(url).toContain("filter%5Bflight_date%5D%5B_eq%5D=2001-09-11");
		expect(url).toContain("fields=flight%2Corigin%2Cscheduled_dest%2Clanded_at%2Cdiverted%2Cgeometry");
		expect(url).toContain("limit=1");
	});
});
