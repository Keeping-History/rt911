import type { ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	classicyFlightRemoteEventHandler,
	flightTrackerFocusFlight,
	flightTrackerSetFocusedFlight,
} from "./flightTrackerCommands";

function storeWithApp(data: Record<string, unknown> = {}): ClassicyStore {
	return {
		System: {
			Manager: {
				Applications: { apps: { "FlightTracker.app": { data } } },
			},
		},
	} as unknown as ClassicyStore;
}

describe("classicyFlightRemoteEventHandler", () => {
	it("writes a seq-command carrying the callsign", () => {
		const out = classicyFlightRemoteEventHandler(
			storeWithApp(),
			flightTrackerFocusFlight("AA11"),
		);
		expect(out.System.Manager.Applications.apps["FlightTracker.app"].data).toMatchObject({
			command: { seq: 1, kind: "focus", callsign: "AA11" },
		});
	});

	it("increments seq monotonically across commands", () => {
		const ds = storeWithApp();
		classicyFlightRemoteEventHandler(ds, flightTrackerFocusFlight("AA11"));
		const out = classicyFlightRemoteEventHandler(ds, flightTrackerFocusFlight("UA175"));
		expect(out.System.Manager.Applications.apps["FlightTracker.app"].data).toMatchObject({
			command: { seq: 2, kind: "focus", callsign: "UA175" },
		});
	});

	it("publishes and clears the focused flight, preserving other fields", () => {
		const ds = storeWithApp({ other: 1 });
		classicyFlightRemoteEventHandler(ds, flightTrackerSetFocusedFlight("UA93"));
		expect(ds.System.Manager.Applications.apps["FlightTracker.app"].data).toMatchObject({
			other: 1,
			focusedFlight: "UA93",
		});
		classicyFlightRemoteEventHandler(ds, flightTrackerSetFocusedFlight(null));
		expect(
			(ds.System.Manager.Applications.apps["FlightTracker.app"].data as Record<string, unknown>)
				.focusedFlight,
		).toBeNull();
	});
});
