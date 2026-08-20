// Cross-app remote-control API for the Flight Tracker (TVContext's pattern).
// Registered under "ClassicyAppFlightRemote", NOT "ClassicyAppFlightTracker*":
// flightMapSettings.ts already owns that prefix and the registry routes by
// first-prefix-match, so a nested prefix would be swallowed by its handler.
import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";

const appId = "FlightTracker.app";

/**
 * One-shot focus command: select the flight with this callsign. `seq` is
 * monotonic so the component applies each command exactly once, retrying while
 * the callsign isn't in the airborne set yet.
 */
export interface FlightRemoteCommand {
	seq: number;
	kind: "focus";
	callsign: string;
}

/** Focus a flight by callsign (e.g. "AA11"). */
export const flightTrackerFocusFlight = (callsign: string): ActionMessage => ({
	type: "ClassicyAppFlightRemoteFocus",
	callsign,
});

/** Publish the currently selected flight (playlist locked-focus reads this). */
export const flightTrackerSetFocusedFlight = (
	callsign: string | null,
): ActionMessage => ({
	type: "ClassicyAppFlightRemoteSetFocused",
	callsign,
});

export const classicyFlightRemoteEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const app = ds.System.Manager.Applications.apps[appId];
	if (!app) return ds;
	const appData = app.data ?? {};

	switch (action.type) {
		case "ClassicyAppFlightRemoteFocus":
			app.data = {
				...appData,
				command: {
					seq: ((appData.command as FlightRemoteCommand | undefined)?.seq ?? 0) + 1,
					kind: "focus",
					callsign: action.callsign as string,
				} satisfies FlightRemoteCommand,
			};
			return ds;
		case "ClassicyAppFlightRemoteSetFocused":
			app.data = { ...appData, focusedFlight: action.callsign as string | null };
			return ds;
		default:
			return ds;
	}
};

registerApp({
	id: appId,
	description:
		"Radar-reconstructed flight map for September 11, 2001 — tracks, loops, and airport POIs.",
	prefix: "ClassicyAppFlightRemote",
	handler: classicyFlightRemoteEventHandler,
	actions: {
		ClassicyAppFlightRemoteFocus: {
			description: "Select the flight with this callsign (one-shot; retries until it is airborne).",
			params: z.object({ callsign: z.string().describe("Callsign to focus, e.g. \"AA11\".") }),
		},
		ClassicyAppFlightRemoteSetFocused: {
			description: "Publish the currently selected flight (playlist locked-focus reads this).",
			params: z.object({
				callsign: z.string().nullable().describe("Selected callsign, or null when nothing is selected."),
			}),
		},
	},
	// State schema intentionally omitted: flightMapSettings.ts is the primary
	// module and its FlightTrackerDataSchema covers command/focusedFlight
	// (handoff §3 — first state schema wins; a second one would warn).
});
