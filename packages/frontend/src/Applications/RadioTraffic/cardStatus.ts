// Which lane a traffic card sits in, and what its header badge reads.
//
// Pure module, no React: the lane and the badge are the two things the card
// shell needs and the two things worth testing exhaustively, so they live apart
// from the component that renders them.
//
// The time windows themselves are NOT defined here. radio-core/stationGrouping
// already owns them and ten other consumers already agree with it; this module
// wraps a single item in a one-item station and asks those same predicates.

import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import {
	activeSegments,
	countdownLabel,
	groupStations,
	upcomingSegments,
} from "../radio-core/stationGrouping";

export type Lane = "live" | "upcoming" | "previous";

export type Badge =
	| { kind: "in-sync" }
	| { kind: "seeking" }
	| { kind: "drift"; seconds: number }
	| { kind: "countdown"; label: string }
	| { kind: "playing" };

/** Drift the header treats as "on the clock" — see badgeFor. */
const IN_SYNC_TOLERANCE_MS = 1_000;

/** Below a minute the countdown drops the MM: prefix ("4s", not "00:04"). */
const COUNTDOWN_SHORT_FORM_SECONDS = 60;

/**
 * The lane `item` belongs to at `nowMs`.
 *
 * The three lanes partition the timeline, so this reads as elimination:
 *
 *   UPCOMING  start > now                     (upcomingSegments)
 *   LIVE      start <= now < effectiveEnd     (activeSegments), and an item with
 *             no end_date AND no calc_duration has no known end, so it stays
 *             live indefinitely rather than falling off the app
 *   PREVIOUS  everything left, which is exactly effectiveEnd <= now — the same
 *             comparison previousSegments makes
 *
 * The PREVIOUS arm is by elimination rather than a third predicate call because
 * previousSegments filters a *history list* an ended item may not be in yet
 * (see rememberItems below). cardStatus.test.ts cross-checks the two agree at
 * the end boundary, so they cannot drift apart unnoticed.
 */
export function laneFor(item: MediaItem, nowMs: number): Lane {
	// groupStations derives the same source/title station key the predicates
	// match on, so a one-item station is always a match for its own item.
	const station = groupStations([item])[0];
	if (upcomingSegments(station, [item], nowMs).length > 0) return "upcoming";
	if (activeSegments(station, nowMs).length > 0) return "live";
	return "previous";
}

/**
 * Countdown text for an UPCOMING card: "4s" inside the last minute, "03:13"
 * beyond it. The MM:SS form is radio-core's countdownLabel unchanged, so the
 * card and the scanner's Coming Up list round identically (up to the whole
 * second, hitting zero exactly at the start instant and never a tick early).
 */
export function countdownFor(item: MediaItem, nowMs: number): string {
	const label = countdownLabel(item, nowMs);
	const [minutes, seconds] = label.split(":").map(Number);
	const total = minutes * 60 + seconds;
	return total < COUNTDOWN_SHORT_FORM_SECONDS ? `${total}s` : label;
}

export interface BadgeArgs {
	lane: Lane;
	/** Where the virtual clock says the audio should be: calcSeekSeconds(item, now) * 1000. */
	liveMs: number;
	/** Where the <audio> element actually is: audioEl.currentTime * 1000. */
	currentMs: number;
	/** A clock seek is in flight — the client is waiting on a fresh window. */
	seeking: boolean;
	/** The listener started this clip themselves (as opposed to it following the clock). */
	userPlaying: boolean;
	/** UPCOMING only: the text from countdownFor(). */
	countdown?: string;
}

/**
 * The header badge, or null when the card shows none.
 *
 * Null is the honest answer for an idle PREVIOUS card: it is not in sync with
 * anything and it is not playing, and every other Badge variant would assert
 * something untrue about it.
 *
 * `seeking` only outranks the LIVE lane. Mid-seek the buffers are dropped and
 * the live card's position is stale, so its drift number is noise — but an
 * UPCOMING countdown is computed from the clock, which is already at the new
 * instant, and a user-started PREVIOUS clip was never following the clock at
 * all. That is why SEEKING shows on one card at a time.
 */
export function badgeFor(args: BadgeArgs): Badge | null {
	if (args.lane === "upcoming") {
		return { kind: "countdown", label: args.countdown ?? "" };
	}
	if (args.lane === "previous") {
		// A back-catalogue clip plays from its own start, so comparing its
		// position against the virtual clock would report a meaningless gap.
		return args.userPlaying ? { kind: "playing" } : null;
	}
	if (args.seeking) return { kind: "seeking" };

	const driftMs = args.currentMs - args.liveMs;
	if (Math.abs(driftMs) <= IN_SYNC_TOLERANCE_MS) return { kind: "in-sync" };
	// Sign is kept: the header reads "-6 seconds" when the audio lags.
	return { kind: "drift", seconds: Math.round(driftMs / 1000) };
}

/**
 * Fold live-seen items into the accumulator, keyed by id, latest copy winning.
 *
 * The streamer's mp3 snapshot fires only on init/subscribe/seek, never on
 * ordinary forward ticking, so an item that ends *between* two snapshots is in
 * no mp3_history frame at all. Without this, such an item drops off the LIVE
 * lane and lands nowhere — it simply disappears mid-session. Everything ever
 * seen live is remembered so PREVIOUS can pick it up; whether it has actually
 * ended is still decided by previousSegments, not by membership here.
 *
 * Mutates `seen` in place: the caller holds it in a ref across renders, and
 * rebuilding the map every tick would allocate for no benefit.
 */
export function rememberItems(
	seen: Map<number, MediaItem>,
	live: readonly MediaItem[],
): void {
	for (const item of live) seen.set(item.id, item);
}

/**
 * The pool PREVIOUS is drawn from: the server's back-catalogue snapshot plus
 * everything seen live since, de-duplicated by id with the live copy winning
 * (it is the fresher row — it may have gained an end_date the snapshot lacked).
 */
export function historyPool(
	history: readonly MediaItem[],
	seen: ReadonlyMap<number, MediaItem>,
): MediaItem[] {
	return Array.from(
		new Map(
			[...history, ...seen.values()].map((i) => [i.id, i] as const),
		).values(),
	);
}
