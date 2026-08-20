// When a clip ran, and how that reads on a card.
//
// Pure module, no React. The windows themselves are not defined here:
// radio-core/stationGrouping already owns "when does this item end", and the
// Details panel must agree with the lane the card is sitting in — a panel that
// derived its own end would eventually print a finish time for a clip the LIVE
// lane still considers running.

import type { MediaItem } from "../../../Providers/MediaStream/MediaStreamContext";
import { effectiveEndMs, startMs } from "../../radio-core/stationGrouping";

export interface ItemTiming {
	/** Epoch ms of the clip's start, or null when the row's date is unusable. */
	startMs: number | null;
	/** Epoch ms of the clip's end, or null when neither end is known. */
	endMs: number | null;
	/** Whole seconds between the two, or null when either end is unknown. */
	durationSec: number | null;
}

/** The three timings the Details panel prints, each independently unknowable. */
export function itemTiming(item: MediaItem): ItemTiming {
	const rawStart = startMs(item);
	const start = Number.isFinite(rawStart) ? rawStart : null;
	const rawEnd = effectiveEndMs(item);
	const end = rawEnd !== null && Number.isFinite(rawEnd) ? rawEnd : null;
	return {
		startMs: start,
		endMs: end,
		durationSec:
			start === null || end === null ? null : Math.max(0, Math.round((end - start) / 1000)),
	};
}

/**
 * An instant as the desktop's own clock reads it: shift the UTC epoch by the
 * display offset and format as UTC. The same trick as stationGrouping's
 * startTimeLabel, so the card and the scanner's schedule agree for every
 * visitor regardless of browser locale — but time-only, because the card is
 * 210px wide and a clip never spans a date the header does not already give.
 */
export function wallClockLabel(ms: number | null, tzOffsetHours: number): string | null {
	if (ms === null || !Number.isFinite(ms)) return null;
	return new Date(ms + tzOffsetHours * 3_600_000).toLocaleString("en-US", {
		timeZone: "UTC",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * MM:SS. Minutes keep counting past 59 rather than rolling into hours, matching
 * stationGrouping's countdownLabel — an hour-long clip reads "90:00", never the
 * "30:00" that would claim a recording a third of its real length.
 */
export function durationLabel(seconds: number | null): string | null {
	if (seconds === null || !Number.isFinite(seconds)) return null;
	const whole = Math.max(0, Math.round(seconds));
	const minutes = Math.floor(whole / 60);
	return `${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
