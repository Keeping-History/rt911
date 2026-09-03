import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { groupStations, previousSegments } from "../radio-core/stationGrouping";
import {
	type Badge,
	badgeFor,
	historyPool,
	laneFor,
	rememberItems,
} from "./cardStatus";

const t = (iso: string) => new Date(iso).getTime();

// Minimal MediaItem factory — only the fields the helpers read matter. Same
// shape as radio-core/stationGrouping.test.ts, deliberately: these tests assert
// that cardStatus classifies exactly as those predicates do.
function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 0,
		title: "t",
		full_title: "t",
		start_date: "2001-09-11T13:00:00.000Z",
		url: "u",
		format: "mp3",
		approved: 1,
		mute: 0,
		volume: 1,
		jump: 0,
		trim: 0,
		...over,
	};
}

describe("laneFor", () => {
	const clip = item({
		id: 1,
		source: "ATC",
		start_date: "2001-09-11T13:00:00.000Z",
		end_date: "2001-09-11T13:05:00.000Z",
	});

	it("is upcoming before the start instant", () => {
		expect(laneFor(clip, t("2001-09-11T12:59:59.000Z"))).toBe("upcoming");
	});

	it("is live from the start instant inclusive", () => {
		// start <= now is the activeSegments window, so the exact start instant is
		// already LIVE — a card must never flip upcoming -> previous with no live
		// frame in between.
		expect(laneFor(clip, t("2001-09-11T13:00:00.000Z"))).toBe("live");
		expect(laneFor(clip, t("2001-09-11T13:02:30.000Z"))).toBe("live");
	});

	it("is previous from the end instant inclusive (end <= now)", () => {
		expect(laneFor(clip, t("2001-09-11T13:05:00.000Z"))).toBe("previous");
		expect(laneFor(clip, t("2001-09-11T13:06:00.000Z"))).toBe("previous");
	});

	it("agrees with radio-core's previousSegments at the end boundary", () => {
		// The predicates in radio-core are authoritative — 10 consumers already
		// depend on them. If someone changes previousSegments' comparison, this
		// cross-check fails rather than letting the two drift apart silently.
		const station = groupStations([clip])[0];
		for (const iso of [
			"2001-09-11T13:04:59.999Z",
			"2001-09-11T13:05:00.000Z",
			"2001-09-11T13:05:00.001Z",
		]) {
			const nowMs = t(iso);
			const inPrevious =
				previousSegments(station, [clip], nowMs).length > 0;
			expect(laneFor(clip, nowMs) === "previous").toBe(inPrevious);
		}
	});

	it("stays live forever for an open-ended item (no end_date, no duration)", () => {
		// A rolling feed with neither end_date nor calc_duration has no known end,
		// so it can never be PREVIOUS — it would otherwise silently drop out of
		// every lane once the clock passed some arbitrary point.
		const openEnded = item({ id: 2, source: "Feed" });
		expect(laneFor(openEnded, t("2001-09-11T12:00:00.000Z"))).toBe("upcoming");
		expect(laneFor(openEnded, t("2001-09-11T13:00:00.000Z"))).toBe("live");
		expect(laneFor(openEnded, t("2001-09-12T09:00:00.000Z"))).toBe("live");
	});

	it("derives the window from calc_duration when end_date is missing", () => {
		const noEndDate = item({ id: 3, source: "ATC", calc_duration: 90 });
		expect(laneFor(noEndDate, t("2001-09-11T13:00:45.000Z"))).toBe("live");
		expect(laneFor(noEndDate, t("2001-09-11T13:01:29.000Z"))).toBe("live");
		expect(laneFor(noEndDate, t("2001-09-11T13:01:30.000Z"))).toBe("previous");
	});

	it("parses tz-less Directus datetimes as UTC, not local time", () => {
		// Directus hands back "2001-09-11 13:00:00" with no zone; reading it as
		// browser-local would shift every lane boundary by the tester's offset.
		const tzLess = item({
			id: 4,
			source: "ATC",
			start_date: "2001-09-11T13:00:00",
			end_date: "2001-09-11T13:05:00",
		});
		expect(laneFor(tzLess, t("2001-09-11T13:02:00.000Z"))).toBe("live");
		expect(laneFor(tzLess, t("2001-09-11T13:06:00.000Z"))).toBe("previous");
	});
});

// countdownFor's own tests moved to radio-core/countdownFormat.test.ts
// alongside the implementation (story: shared with RadioTuner's balloon help).

describe("badgeFor", () => {
	const live = {
		lane: "live" as const,
		liveMs: 30_000,
		currentMs: 30_000,
		seeking: false,
		userPlaying: false,
	};

	it("is in-sync when the audio element is exactly on the clock", () => {
		expect(badgeFor(live)).toEqual({ kind: "in-sync" });
	});

	// Story 041. The precedence silence.ts documents, asserted from the badge's
	// side: silence is what is LEFT once the card is on the clock and playing,
	// so it can only ever replace in-sync — never drift, and never seeking.
	describe("silence", () => {
		it("reads silence instead of in-sync when the tape is quiet", () => {
			expect(badgeFor({ ...live, silent: true })).toEqual({ kind: "silence" });
		});

		it("still reads in-sync when the tape is carrying traffic", () => {
			expect(badgeFor({ ...live, silent: false })).toEqual({ kind: "in-sync" });
		});

		// The important one. A card off the clock has to say so even over a quiet
		// stretch, or the listener loses the more important signal behind the
		// less important one.
		it("lets drift outrank silence", () => {
			expect(badgeFor({ ...live, currentMs: 24_000, silent: true })).toEqual({
				kind: "drift",
				seconds: -6,
			});
		});

		it("lets seeking outrank silence", () => {
			expect(badgeFor({ ...live, seeking: true, silent: true })).toEqual({
				kind: "seeking",
			});
		});

		// UPCOMING has no audio to be quiet — the clip has not started.
		it("never reads silence on an upcoming card", () => {
			expect(
				badgeFor({ ...live, lane: "upcoming", countdown: "4s", silent: true }),
			).toEqual({ kind: "countdown", label: "4s" });
		});

		// A listener playing a back-catalogue clip through a quiet stretch is
		// better served by "Silence" than by "Playing", which they already know.
		it("reads silence over playing on a manually played previous clip", () => {
			expect(
				badgeFor({ ...live, lane: "previous", userPlaying: true, silent: true }),
			).toEqual({ kind: "silence" });
		});

		it("still reads nothing on an idle previous card", () => {
			expect(
				badgeFor({ ...live, lane: "previous", userPlaying: false, silent: true }),
			).toBeNull();
		});
	});

	it("is in-sync while absolute drift is at most one second", () => {
		// Sub-second wander is normal for an <audio> element being polled once a
		// second; showing a drift badge for it would flicker constantly.
		expect(badgeFor({ ...live, currentMs: 29_000 })).toEqual({ kind: "in-sync" });
		expect(badgeFor({ ...live, currentMs: 31_000 })).toEqual({ kind: "in-sync" });
		expect(badgeFor({ ...live, currentMs: 30_400 })).toEqual({ kind: "in-sync" });
	});

	it("reports negative seconds when the audio lags the clock", () => {
		// 6s behind reads "-6 seconds" in the header; the sign is the whole point,
		// so it lives in the badge rather than in the renderer.
		expect(badgeFor({ ...live, currentMs: 24_000 })).toEqual({
			kind: "drift",
			seconds: -6,
		});
	});

	it("reports positive seconds when the audio runs ahead of the clock", () => {
		expect(badgeFor({ ...live, currentMs: 36_000 })).toEqual({
			kind: "drift",
			seconds: 6,
		});
	});

	it("leaves in-sync continuously — the first drift shown is three seconds", () => {
		// REWRITTEN for the hysteresis deadband (story 042). This used to pin the
		// handoff at 1s, because 1s was the whole band. Widening the ENTER edge to
		// 3s necessarily makes the first number shown larger — that is the cost of
		// not flickering, not a regression — so the assertion moves to the new edge
		// rather than being dropped. What it pins is unchanged and is the point:
		// the badge must not GAP. The value just past the edge has to be the value
		// the edge sits on, or the header flicks from "In sync" straight to a
		// number it never counted up through.
		expect(badgeFor({ ...live, currentMs: 30_000 - 3_000 })).toEqual({
			kind: "in-sync",
		});
		expect(badgeFor({ ...live, currentMs: 30_000 - 3_001 })).toEqual({
			kind: "drift",
			seconds: -3,
		});
		expect(badgeFor({ ...live, currentMs: 30_000 - 3_400 })).toEqual({
			kind: "drift",
			seconds: -3,
		});
	});

	it("holds in-sync out to the wider enter threshold", () => {
		// Between the old 1s tolerance and the new 3s one: a card here used to
		// repaint a drift number several times a second and now says nothing.
		for (const ms of [1_001, 2_000, 2_999, 3_000]) {
			expect(badgeFor({ ...live, currentMs: 30_000 + ms })).toEqual({
				kind: "in-sync",
			});
			expect(badgeFor({ ...live, currentMs: 30_000 - ms })).toEqual({
				kind: "in-sync",
			});
		}
	});

	it("switches to drift once past the enter threshold, in either direction", () => {
		expect(
			badgeFor({ ...live, currentMs: 30_000 + 3_001, previousKind: "in-sync" }),
		).toEqual({ kind: "drift", seconds: 3 });
		expect(
			badgeFor({ ...live, currentMs: 30_000 - 3_001, previousKind: "in-sync" }),
		).toEqual({ kind: "drift", seconds: -3 });
	});

	it("keeps showing drift inside the deadband until it clears the exit threshold", () => {
		// The asymmetry itself. Every one of these is BELOW the 3s enter edge, so a
		// memoryless badgeFor would call them all in sync; a card that is already
		// reporting drift must keep reporting it until it is properly back.
		for (const [ms, seconds] of [
			[2_999, -3],
			[2_000, -2],
			[1_500, -1],
			[1_001, -1],
		] as const) {
			expect(
				badgeFor({ ...live, currentMs: 30_000 - ms, previousKind: "drift" }),
			).toEqual({ kind: "drift", seconds });
		}
		expect(
			badgeFor({ ...live, currentMs: 30_000 - 1_000, previousKind: "drift" }),
		).toEqual({ kind: "in-sync" });
	});

	it("returns to in-sync continuously too — the last drift shown is one second", () => {
		// The exit edge needs the same no-gap property the enter edge has: -1s then
		// "In sync", never -2s then "In sync".
		expect(
			badgeFor({ ...live, currentMs: 30_000 - 1_001, previousKind: "drift" }),
		).toEqual({ kind: "drift", seconds: -1 });
		expect(
			badgeFor({ ...live, currentMs: 30_000 - 1_000, previousKind: "drift" }),
		).toEqual({ kind: "in-sync" });
	});

	it("does not flicker while drift oscillates between the two thresholds", () => {
		// The bug, reproduced: the element is polled ~4x/sec and wanders either
		// side of a boundary. Feed the badge back into itself the way the card
		// does and walk the drift up through the deadband and back down; it must
		// change its mind exactly TWICE across the whole sweep.
		const walk = (drifts: number[]) => {
			let kind: Badge["kind"] | undefined;
			const labels: string[] = [];
			for (const driftMs of drifts) {
				const badge = badgeFor({
					...live,
					currentMs: 30_000 + driftMs,
					previousKind: kind,
				});
				if (badge === null) throw new Error("a live card always has a badge");
				if (badge.kind !== kind) labels.push(badge.kind);
				kind = badge.kind;
			}
			return labels;
		};

		// Up through the deadband and back down: one flip out, one flip back.
		expect(walk([0, 1_200, 2_400, 2_900, 3_200, 2_900, 2_400, 1_200, 800, 0])).toEqual([
			"in-sync",
			"drift",
			"in-sync",
		]);
		// The same sweep on the lagging side.
		expect(
			walk([0, -1_200, -2_400, -2_900, -3_200, -2_900, -2_400, -1_200, -800, 0]),
		).toEqual(["in-sync", "drift", "in-sync"]);
		// Noise that never leaves the deadband never flips anything at all.
		expect(walk([0, 1_100, -1_400, 2_800, -2_950, 1_050, -2_999])).toEqual([
			"in-sync",
		]);
		// And noise straddling the EXIT edge while already drifting stays drifting.
		expect(
			walk([0, 3_500, 1_400, 2_600, 1_050, 2_900, 1_200]).slice(1),
		).toEqual(["drift"]);
	});

	it("is seeking while a seek is in flight, outranking any drift", () => {
		// Mid-seek the clip's position is meaningless: the client has dropped its
		// buffers and is waiting on a fresh window. Reporting the stale gap as
		// drift would show an alarming number that resolves itself a tick later.
		expect(badgeFor({ ...live, seeking: true, currentMs: 24_000 })).toEqual({
			kind: "seeking",
		});
	});

	it("shows the countdown for an upcoming card", () => {
		expect(
			badgeFor({
				lane: "upcoming",
				liveMs: 0,
				currentMs: 0,
				seeking: false,
				userPlaying: false,
				countdown: "03:13",
			}),
		).toEqual({ kind: "countdown", label: "03:13" });
	});

	it("keeps the countdown on an upcoming card during a seek", () => {
		// The countdown is derived from the virtual clock, which is already at the
		// new instant — only the LIVE card is waiting on stream data, so only it
		// goes SEEKING. That is why the mock shows SEEKING on one card at a time.
		expect(
			badgeFor({
				lane: "upcoming",
				liveMs: 0,
				currentMs: 0,
				seeking: true,
				userPlaying: false,
				countdown: "4s",
			}),
		).toEqual({ kind: "countdown", label: "4s" });
	});

	it("is playing for a user-started previous clip", () => {
		expect(
			badgeFor({
				lane: "previous",
				liveMs: 0,
				currentMs: 12_000,
				seeking: false,
				userPlaying: true,
			}),
		).toEqual({ kind: "playing" });
	});

	it("has no badge for a previous clip sitting idle", () => {
		// An ended clip nobody started is not in sync with anything and is not
		// playing — the header shows no badge at all rather than a misleading one.
		expect(
			badgeFor({
				lane: "previous",
				liveMs: 0,
				currentMs: 0,
				seeking: false,
				userPlaying: false,
			}),
		).toBeNull();
	});

	it("does not report drift on a user-started previous clip", () => {
		// A back-catalogue clip is played from its own start, so its position has
		// no relationship to the virtual clock. Drift here would always be huge.
		expect(
			badgeFor({
				lane: "previous",
				liveMs: 300_000,
				currentMs: 2_000,
				seeking: false,
				userPlaying: true,
			}),
		).toEqual({ kind: "playing" });
	});
});

describe("seen-items accumulator", () => {
	// sendMp3Snapshot only fires on init/subscribe/seek, never on ordinary
	// forward ticking. An item that ends between two snapshots is therefore in no
	// mp3_history frame — without the accumulator it vanishes off the LIVE lane
	// with nothing to catch it in PREVIOUS.
	const clip = item({
		id: 7,
		source: "ATC",
		start_date: "2001-09-11T13:00:00.000Z",
		end_date: "2001-09-11T13:00:30.000Z",
	});
	const station = groupStations([clip])[0];
	const afterEnd = t("2001-09-11T13:01:00.000Z");

	it("proves the gap is real: an unseen item is in no history frame", () => {
		// The failure this accumulator exists to prevent. If this ever passes with
		// the item present, the streamer started snapshotting on forward ticks and
		// the accumulator can be reconsidered.
		expect(previousSegments(station, [], afterEnd)).toEqual([]);
	});

	it("keeps an item that ended between snapshots in PREVIOUS", () => {
		const seen = new Map<number, MediaItem>();
		rememberItems(seen, [clip]); // seen live, while it was playing
		// No mp3_history frame has arrived since; the clock just ticked past the end.
		const pool = historyPool([], seen);

		expect(previousSegments(station, pool, afterEnd).map((i) => i.id)).toEqual([7]);
		expect(laneFor(clip, afterEnd)).toBe("previous");
	});

	it("accumulates across ticks rather than replacing", () => {
		const seen = new Map<number, MediaItem>();
		rememberItems(seen, [clip]);
		rememberItems(seen, [item({ id: 8, source: "ATC" })]);
		expect(historyPool([], seen).map((i) => i.id).sort()).toEqual([7, 8]);
	});

	it("merges with the server's history by id, the later-seen copy winning", () => {
		// The same row can arrive twice: once in a snapshot and once live. The
		// live copy is the fresher one (it may carry a resolved end_date).
		const stale = { ...clip, end_date: undefined, full_title: "stale" };
		const seen = new Map<number, MediaItem>();
		rememberItems(seen, [clip]);
		const pool = historyPool([stale], seen);

		expect(pool).toHaveLength(1);
		expect(pool[0].full_title).toBe("t");
		expect(pool[0].end_date).toBe("2001-09-11T13:00:30.000Z");
	});

	it("keeps server history entries the client never saw live", () => {
		// The accumulator supplements the snapshot; it must not shadow it. The
		// back-catalogue predates this session entirely.
		const old = item({
			id: 9,
			source: "ATC",
			start_date: "2001-09-11T12:40:00.000Z",
			end_date: "2001-09-11T12:41:00.000Z",
		});
		const seen = new Map<number, MediaItem>();
		rememberItems(seen, [clip]);

		expect(
			previousSegments(station, historyPool([old], seen), afterEnd).map((i) => i.id),
		).toEqual([7, 9]);
	});

	it("does not surface a still-playing item as PREVIOUS", () => {
		// Everything live goes into the pool, so the pool alone is not the lane —
		// previousSegments' end <= now test is what still decides.
		const seen = new Map<number, MediaItem>();
		rememberItems(seen, [clip]);
		const midClip = t("2001-09-11T13:00:15.000Z");

		expect(previousSegments(station, historyPool([], seen), midClip)).toEqual([]);
		expect(laneFor(clip, midClip)).toBe("live");
	});
});
