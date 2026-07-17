import { registerHyperCardEffectHandler, useAppManager, useClassicyDateTime } from "classicy";
import { useEffect, useRef } from "react";
import { setDateTimeFromUtc } from "../../TimeMachine/setVirtualClock";
import { clampClockIso } from "./dateRange";

/**
 * Bridges the HyperCard `setDateTime` action to the virtual clock.
 *
 * A HyperCard command runs inside classicy's pure reducer and can't touch the
 * app-manager clock directly, so the `setDateTime` command (registered in
 * registerHyperCardExtensions) only *queues* a custom effect. This mounted
 * component registers the matching effect handler — the one place with live
 * access to the clock — and applies the seek through the sanctioned
 * `setDateTimeFromUtc` seam (frontend CLAUDE.md hard-rule #2), clamped to the
 * canonical date range.
 *
 * Mounted once above the desktop (see Desktop.tsx). Renders nothing.
 */
export function HyperCardClockBridge() {
	const { setDateTime } = useClassicyDateTime();
	// Forced-clock mode locks the date/time editors; honour it the same way the
	// other user-driven seek writers (TimeMachine, mobile Time Travel) do.
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked,
	);

	// The effect handler is registered once but must always see the latest
	// setDateTime/lock — hold them in a ref rather than re-registering.
	const latest = useRef({ setDateTime, dateTimeLocked });
	latest.current = { setDateTime, dateTimeLocked };

	useEffect(() => {
		registerHyperCardEffectHandler("setDateTime", (args) => {
			const { setDateTime, dateTimeLocked } = latest.current;
			if (dateTimeLocked) return; // the streamer's forced clock wins
			const to = typeof args.to === "string" ? args.to : undefined;
			if (!to) return;
			const clamped = clampClockIso(to);
			if (!clamped) {
				console.warn(`HyperCard setDateTime: unparseable date "${to}"`);
				return;
			}
			setDateTimeFromUtc(setDateTime, clamped.iso);
		});
	}, []);

	return null;
}
