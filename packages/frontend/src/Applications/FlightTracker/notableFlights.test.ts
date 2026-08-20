import { describe, expect, it } from "vitest";
import { NOTABLE_FLIGHTS, OBSERVER_FLIGHTS, isNotable, isObserver, isObserverStyled, isPresidential } from "./notableFlights";

describe("notableFlights", () => {
	it("lists exactly the four hijacked flights", () => {
		expect([...NOTABLE_FLIGHTS].sort()).toEqual(["AA11", "AA77", "UA175", "UA93"]);
	});
	it("matches a notable flight and rejects a regular one", () => {
		expect(isNotable("AA11")).toBe(true);
		expect(isNotable("AA1002")).toBe(false);
	});
	it("lists GOFER06 as an observer, distinct from the notables", () => {
		expect([...OBSERVER_FLIGHTS]).toEqual(["GOFER06"]);
		expect(isObserver("GOFER06")).toBe(true);
		expect(isObserver("AA11")).toBe(false);
		// crash semantics (crash sites, persist-at-impact, ACTIVE TRACK badge)
		// key off isNotable and must NOT extend to the observer
		expect(isNotable("GOFER06")).toBe(false);
	});
});

describe("presidential category (AF1)", () => {
	it("AF1 is presidential, not notable, not observer", () => {
		expect(isPresidential("AF1")).toBe(true);
		expect(isNotable("AF1")).toBe(false);
		expect(isObserver("AF1")).toBe(false);
	});
	it("observer styling covers observers and presidential aircraft", () => {
		expect(isObserverStyled("GOFER06")).toBe(true);
		expect(isObserverStyled("AF1")).toBe(true);
		expect(isObserverStyled("AA11")).toBe(false);
		expect(isObserverStyled("DL1989")).toBe(false);
	});
});
