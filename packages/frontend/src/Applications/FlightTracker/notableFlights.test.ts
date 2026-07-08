import { describe, expect, it } from "vitest";
import { NOTABLE_FLIGHTS, isNotable } from "./notableFlights";

describe("notableFlights", () => {
	it("lists exactly the four hijacked flights", () => {
		expect([...NOTABLE_FLIGHTS].sort()).toEqual(["AA11", "AA77", "UA175", "UA93"]);
	});
	it("matches a notable flight and rejects a regular one", () => {
		expect(isNotable("AA11")).toBe(true);
		expect(isNotable("AA1002")).toBe(false);
	});
});
