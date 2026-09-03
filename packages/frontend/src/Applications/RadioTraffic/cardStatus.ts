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
	groupStations,
	upcomingSegments,
} from "../radio-core/stationGrouping";

export type Lane = "live" | "upcoming" | "previous";

export type Badge =
	| { kind: "in-sync" }
	| { kind: "seeking" }
	| { kind: "drift"; seconds: number }
	| { kind: "countdown"; label: string }
	| { kind: "playing" }
	// Story 041. Ranked below drift and seeking — see silence.ts's header, and
	// the `silent` flag on BadgeArgs. It is what is LEFT once a card is on the
	// clock and playing, so it only ever replaces in-sync.
	| { kind: "silence" };

/**
 * The two edges of the in-sync deadband, in ms of absolute drift.
 *
 * ENTER is what an in-sync card is allowed to wander by before the header stops
 * calling it in sync; EXIT is the tighter figure a drifting card has to come
 * back inside before the header says so again. One threshold — this was a single
 * 1s tolerance — flickers by construction: the element's position is polled ~4
 * times a second and wanders either side of any single number, so a clip parked
 * on the boundary repaints "In sync"/"-1s"/"In sync" several times a second.
 * Two thresholds mean the badge has to *travel* 2 seconds to change its mind,
 * which no amount of polling noise does.
 *
 * EXIT keeps the old 1s figure deliberately: it is the drift the app has always
 * called on the clock, so a card that settles back reports in sync at exactly
 * the same point it used to, and the badge's meaning has not changed — only how
 * hard it is to dislodge.
 */
const DRIFT_ENTER_MS = 3_000;
const DRIFT_EXIT_MS = 1_000;

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
	/** UPCOMING only: the text from radio-core's countdownFor(). */
	countdown?: string;
	/**
	 * What this same card's badge read last tick, or undefined on the first one.
	 *
	 * The one piece of history badgeFor needs, and it is an ARGUMENT rather than
	 * something the module remembers so that the function stays pure: a badge
	 * decided from state hidden in this module would be untestable in isolation,
	 * would leak an entry per card, and would make two cards' test cases
	 * order-dependent on each other. The caller already re-renders every tick, so
	 * carrying one string across those renders costs it a ref and nothing else.
	 */
	previousKind?: Badge["kind"];
	/**
	 * The tape is carrying nothing under the playhead — `isSilentAt` from
	 * silence.ts, which reads the peaks envelope the card already draws.
	 *
	 * A flag rather than a badge because it can be outranked: a card that is off
	 * the clock has to report that even when the tape happens to be quiet. So the
	 * predicate has no business knowing where it sits in the order, and this
	 * function does.
	 */
	silent?: boolean;
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
 *
 * Still a pure function, but no longer a memoryless one: the in-sync/drift
 * decision reads `args.previousKind` so the deadband can be asymmetric. Same
 * arguments in, same badge out — the history is data the caller hands over, not
 * state this module keeps.
 */
export function badgeFor(args: BadgeArgs): Badge | null {
	if (args.lane === "upcoming") {
		return { kind: "countdown", label: args.countdown ?? "" };
	}
	if (args.lane === "previous") {
		// A back-catalogue clip plays from its own start, so comparing its
		// position against the virtual clock would report a meaningless gap.
		if (!args.userPlaying) return null;
		// Silence outranks "Playing" here: the listener pressed play, so they
		// already know it is playing — what they cannot see is that the tape has
		// gone quiet under them.
		return args.silent ? { kind: "silence" } : { kind: "playing" };
	}
	if (args.seeking) return { kind: "seeking" };

	const driftMs = args.currentMs - args.liveMs;
	// Asymmetric by design — see DRIFT_ENTER_MS. Anything that is not already a
	// drift badge (including the first tick, a card coming out of SEEKING, and a
	// card that has just started) has to clear the wide edge to become one.
	const tolerance =
		args.previousKind === "drift" ? DRIFT_EXIT_MS : DRIFT_ENTER_MS;
	// Silence is what is left: on the clock, playing, carrying nothing. Placed
	// after the drift test on purpose — drift outranks it, so a card that has
	// wandered says so even over a quiet stretch.
	if (Math.abs(driftMs) <= tolerance) {
		return args.silent ? { kind: "silence" } : { kind: "in-sync" };
	}
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
