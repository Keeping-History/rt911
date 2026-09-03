// Shared "how long until this starts" formatter.
//
// Lives in radio-core (not RadioTraffic, where it was first written) because
// RadioTuner's station-strip balloon and under-logo countdown need the exact
// same variable-width rendering RadioTraffic's upcoming-lane badge already
// uses — two implementations of the same rounding/field-width rules would
// drift the instant one of them got a bug fix the other didn't.

import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { countdownLabel } from "./stationGrouping";

/** Below a minute the countdown drops the MM: prefix ("4s", not "00:04"). */
const COUNTDOWN_SHORT_FORM_SECONDS = 60;

/** From an hour out the countdown grows an HH field, so 90 minutes is not "90:00". */
const SECONDS_PER_HOUR = 3_600;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * Countdown text for an item that hasn't started yet: "4s" inside the last
 * minute, "03:13" beyond it, "01:30:00" from an hour out.
 *
 * The *rounding* is radio-core's countdownLabel unchanged — every consumer
 * agrees up to the whole second, hitting zero exactly at the start instant
 * and never a tick early — but the *rendering* is this module's. countdownLabel
 * is unbounded in its minutes field, so an item two hours out reads "120:00"
 * there: correct arithmetic, but a badge that makes a listener divide by 60 in
 * their head, and one that reads as a plausible-but-wrong "1:20" at a glance.
 * Hours are split off here rather than in stationGrouping because ten other
 * consumers already agree on that MM:SS form and none of them asked for this.
 */
export function countdownFor(item: MediaItem, nowMs: number): string {
	const [minutes, seconds] = countdownLabel(item, nowMs).split(":").map(Number);
	const total = minutes * 60 + seconds;

	if (total < COUNTDOWN_SHORT_FORM_SECONDS) return `${total}s`;
	if (total < SECONDS_PER_HOUR) {
		return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
	}
	// Every field is two digits, so the badge's width never moves as the clock
	// runs down and the header's subject never reflows a character at a time.
	const hours = Math.floor(total / SECONDS_PER_HOUR);
	const rest = total % SECONDS_PER_HOUR;
	return `${pad2(hours)}:${pad2(Math.floor(rest / 60))}:${pad2(rest % 60)}`;
}
