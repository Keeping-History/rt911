import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { toggleFlightSelection } from "./selectionToggle";

const fp = (flight: string): FlightPosition => ({
	id: 1, flight, carrier: "AA", start_date: "2001-09-11T12:30:00Z",
	lat: 0, lon: 0, alt_ft: 30000, phase: "cruise",
});

describe("toggleFlightSelection", () => {
	it("appends an absent flight and makes it active", () => {
		const r = toggleFlightSelection([fp("AA11")], fp("UA175"), 0);
		expect(r.list.map((p) => p.flight)).toEqual(["AA11", "UA175"]);
		expect(r.activeIdx).toBe(1);
	});
	it("removes a present flight (matched by callsign)", () => {
		const r = toggleFlightSelection([fp("AA11"), fp("UA175")], fp("AA11"), 1);
		expect(r.list.map((p) => p.flight)).toEqual(["UA175"]);
		// active was 1; removing index 0 (<= active) shifts it to 0
		expect(r.activeIdx).toBe(0);
	});
	it("clamps activeIdx to 0 when the list empties", () => {
		const r = toggleFlightSelection([fp("AA11")], fp("AA11"), 0);
		expect(r.list).toEqual([]);
		expect(r.activeIdx).toBe(0);
	});
	it("keeps activeIdx when removing an entry after it", () => {
		const r = toggleFlightSelection([fp("AA11"), fp("UA175"), fp("UA93")], fp("UA93"), 0);
		expect(r.list.map((p) => p.flight)).toEqual(["AA11", "UA175"]);
		expect(r.activeIdx).toBe(0);
	});
});
