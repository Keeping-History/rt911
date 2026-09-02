import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { effectiveMutedIds } from "../radio-core/radioPlayback";
import { type Lane, laneFor } from "./cardStatus";
import {
	applyToolClick,
	type AudioState,
	autoSoloTarget,
	INITIAL_AUDIO_STATE,
	isAudible,
	reconcileSolo,
	releaseLaneMute,
} from "./toolMode";

const t = (iso: string) => new Date(iso).getTime();

// Minimal MediaItem factory — same shape cardStatus.test.ts uses, so the lane
// classification these tests lean on is the real one, not a stand-in.
function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 0,
		title: "t",
		full_title: "t",
		source: "ATC",
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

/** Three overlapping clips, so a mix always has somewhere else to go. */
const A = item({
	id: 10,
	source: "ATC",
	start_date: "2001-09-11T13:00:00.000Z",
	end_date: "2001-09-11T13:04:00.000Z",
});
const B = item({
	id: 11,
	source: "Rutgers",
	start_date: "2001-09-11T13:01:00.000Z",
	end_date: "2001-09-11T13:10:00.000Z",
});
const C = item({
	id: 12,
	source: "FDNY",
	start_date: "2001-09-11T13:02:00.000Z",
	end_date: "2001-09-11T13:10:00.000Z",
});
const ALL = [A, B, C];

interface MixOptions {
	/** Ids a tag filter has removed from the grid. */
	hidden?: ReadonlySet<number>;
	/** Ids whose <audio> element reported `ended`. */
	ended?: ReadonlySet<number>;
}

/**
 * What the app shell hands reconcileSolo: the LIVE, filter-visible, still-
 * playing cards. Every way an item can leave the mix goes through here, which
 * is why the three release tests below can differ in mechanism and still assert
 * the same outcome.
 */
function mixAt(nowMs: number, opts: MixOptions = {}): MediaItem[] {
	return ALL.filter((i) => laneFor(i, nowMs) === "live")
		.filter((i) => !opts.hidden?.has(i.id))
		.filter((i) => !opts.ended?.has(i.id));
}

/** Absence of silence: at least one card in the mix can still be heard. */
function somethingAudible(state: AudioState, mix: readonly MediaItem[]): boolean {
	return mix.some((i) => isAudible(state, i.id, "live"));
}

const state = (soloId: number | null, muted: number[] = []): AudioState => ({
	soloId,
	muted: new Set(muted),
});

describe("isAudible", () => {
	it("is exactly effectiveMutedIds' answer, not a second solo model", () => {
		// The tuner's rule, asked one card at a time. If someone changes
		// effectiveMutedIds, this fails rather than letting the card grid and the
		// tuner disagree about what "soloed" means.
		for (const soloId of [null, 10, 11, 99]) {
			for (const muted of [[], [10], [10, 11], [11, 12]]) {
				for (const id of [10, 11, 12]) {
					const byCore = !effectiveMutedIds(muted, soloId, [id]).includes(id);
					expect(isAudible(state(soloId, muted), id, "live")).toBe(byCore);
				}
			}
		}
	});

	it("honours a manual mute when nothing is soloed", () => {
		expect(isAudible(state(null, [11]), 10, "live")).toBe(true);
		expect(isAudible(state(null, [11]), 11, "live")).toBe(false);
	});

	it("mutes every other live card while one is soloed", () => {
		const soloed = state(11);
		expect(isAudible(soloed, 11, "live")).toBe(true);
		expect(isAudible(soloed, 10, "live")).toBe(false);
		expect(isAudible(soloed, 12, "live")).toBe(false);
	});

	it("keeps the solo target audible even though it was manually muted", () => {
		// Un-soloing restores the manual state untouched — radioPlayback.ts's
		// documented contract, and the reason solo does not clear the mute set.
		expect(isAudible(state(11, [11]), 11, "live")).toBe(true);
		expect(isAudible(state(null, [11]), 11, "live")).toBe(false);
	});

	it("is false off the LIVE lane — the mix is the live cards", () => {
		for (const lane of ["upcoming", "previous"] as Lane[]) {
			expect(isAudible(state(10), 10, lane)).toBe(false);
			expect(isAudible(INITIAL_AUDIO_STATE, 10, lane)).toBe(false);
		}
	});
});

describe("applyToolClick", () => {
	describe("arrow", () => {
		it("solos the clicked card and silences every other live card", () => {
			const next = applyToolClick(state(null), "arrow", 11);
			expect(next.soloId).toBe(11);
			expect(isAudible(next, 11, "live")).toBe(true);
			expect(isAudible(next, 10, "live")).toBe(false);
			expect(isAudible(next, 12, "live")).toBe(false);
		});

		it("moves the solo rather than accumulating one per click", () => {
			const next = applyToolClick(applyToolClick(state(null), "arrow", 11), "arrow", 12);
			expect(next.soloId).toBe(12);
			expect(isAudible(next, 11, "live")).toBe(false);
		});

		it("leaves the manual mute set untouched", () => {
			const next = applyToolClick(state(null, [10, 12]), "arrow", 11);
			expect([...next.muted].sort()).toEqual([10, 12]);
		});

		it("returns the same object when the card is already soloed", () => {
			// Identity matters: the shell feeds this back into React state, and a
			// fresh object every click would re-render the whole grid for nothing.
			const before = state(11);
			expect(applyToolClick(before, "arrow", 11)).toBe(before);
		});
	});

	describe("mute", () => {
		it("mutes only the clicked card", () => {
			const next = applyToolClick(state(null), "mute", 11);
			expect([...next.muted]).toEqual([11]);
			expect(isAudible(next, 11, "live")).toBe(false);
			expect(isAudible(next, 10, "live")).toBe(true);
			expect(isAudible(next, 12, "live")).toBe(true);
		});

		it("accumulates — each card carries its own mute", () => {
			const next = applyToolClick(applyToolClick(state(null), "mute", 10), "mute", 12);
			expect([...next.muted].sort()).toEqual([10, 12]);
			expect(isAudible(next, 11, "live")).toBe(true);
		});

		it("releases the solo when the muted card IS the solo target, materialising every other mix member's implicit silence", () => {
			// Otherwise the click is a silent no-op: effectiveMutedIds keeps the solo
			// target audible in spite of its manual mute, so the one card the
			// listener is actually hearing would be the one card they cannot mute.
			// And every OTHER live card was only silent because the solo excepted
			// 11 from an implicit mute — dropping the solo without folding that
			// implicit silence into `muted` would reopen the whole board the moment
			// the listener silenced the one thing they were listening to.
			const next = applyToolClick(state(11, []), "mute", 11, ALL);
			expect(next.soloId).toBeNull();
			expect(isAudible(next, 11, "live")).toBe(false);
			expect([...next.muted].sort()).toEqual([10, 11, 12]);
		});

		it("repro: soloing a card then muting it silences the board, not reopens it", () => {
			// Solo 11 among [10, 11, 12] — everyone else is only implicitly quiet —
			// then mute 11 with the mute tool. Not the right design for it to hand
			// 10 and 12 back audible with no click of their own; muting the one card
			// you are listening to should silence the board.
			const soloed = applyToolClick(state(null), "arrow", 11);
			const next = applyToolClick(soloed, "mute", 11, ALL);
			expect(next.soloId).toBeNull();
			expect([...next.muted].sort()).toEqual([10, 11, 12]);
			for (const id of [10, 11, 12]) expect(isAudible(next, id, "live")).toBe(false);
		});

		it("returns the same object when the card is already muted", () => {
			const before = state(null, [11]);
			expect(applyToolClick(before, "mute", 11)).toBe(before);
		});
	});

	describe("unmute", () => {
		it("unmutes only the clicked card", () => {
			const next = applyToolClick(state(null, [10, 11, 12]), "unmute", 11);
			expect([...next.muted].sort()).toEqual([10, 12]);
			expect(isAudible(next, 11, "live")).toBe(true);
			expect(isAudible(next, 10, "live")).toBe(false);
		});

		it("does not solo the card it unmutes", () => {
			const next = applyToolClick(state(null, [11]), "unmute", 11);
			expect(next.soloId).toBeNull();
		});

		it("returns the same object when the card is not muted", () => {
			const before = state(null, [10]);
			expect(applyToolClick(before, "unmute", 11)).toBe(before);
		});

		it("issue 552: unmute-clicking a non-solo card while a solo is active releases the solo and materialises every other card's implicit silence", () => {
			// Solo 10, then Unmute-click 11 — 11 was never explicitly muted (it was
			// silent only because the solo excepted 10 from an implicit mute), so
			// the old code's `if (!state.muted.has(itemId)) return state;` guard
			// made this a silent no-op. Both 11 (clicked) and 10 (outgoing solo
			// target) must stay audible; everyone else becomes an explicit mute.
			const soloed = applyToolClick(state(null), "arrow", 10);
			const next = applyToolClick(soloed, "unmute", 11, ALL);

			expect(next.soloId).toBeNull();
			expect(isAudible(next, 11, "live")).toBe(true);
			expect(isAudible(next, 10, "live")).toBe(true);
			expect(isAudible(next, 12, "live")).toBe(false);
			expect([...next.muted].sort()).toEqual([12]);
		});

		it("issue 552: a follow-up click on a third card now acts immediately, instead of silently no-op'ing", () => {
			const soloed = applyToolClick(state(null), "arrow", 10);
			const afterUnmute = applyToolClick(soloed, "unmute", 11, ALL);

			// 12 is explicitly muted now (see the test above), so the mute tool must
			// be a no-op (already muted) and the unmute tool must bring it back —
			// this is the "originally silently no-op'd" click the bug report describes.
			expect(applyToolClick(afterUnmute, "mute", 12)).toBe(afterUnmute);
			const unmuted12 = applyToolClick(afterUnmute, "unmute", 12);
			expect(isAudible(unmuted12, 12, "live")).toBe(true);
			expect(unmuted12.soloId).toBeNull();
		});

		it("issue 552: unmute-clicking the solo target itself is unchanged — the existing early-return case", () => {
			const soloed = applyToolClick(state(null), "arrow", 10);
			// 10 is the solo target and was never explicitly muted, so the click is
			// the plain "not in `muted`" no-op, exactly as before this fix.
			expect(applyToolClick(soloed, "unmute", 10, ALL)).toBe(soloed);
		});

		it("issue 552: suspends auto-solo, the same as the mute tool's release of the same solo", () => {
			// The listener now has TWO cards intentionally audible with no solo — a
			// state reconcileSolo has no way to represent other than "don't
			// reassign". Leaving auto-solo armed here was the actual bug: unlike a
			// single unit-test call, the shell's reconcileSolo effect re-runs on
			// every visible-mix tick, so on the very next one it picked ONE of these
			// two cards and folded the other back into the solo's implicit mute,
			// undoing the click within about a second.
			const soloed = applyToolClick(state(null), "arrow", 10);
			const next = applyToolClick(soloed, "unmute", 11, ALL);
			expect(next.autoSoloSuspended).toBe(true);
		});
	});

	describe("hand", () => {
		it("neither solos nor mutes — it is the drag tool", () => {
			for (const before of [state(null), state(11), state(null, [10])]) {
				expect(applyToolClick(before, "hand", 12)).toBe(before);
			}
		});
	});

	it("keeps per-card mute state across a tool change", () => {
		// The tool lives outside AudioState precisely so switching it cannot touch
		// the mix: mute two cards, pass through every other tool, mutes intact.
		let s = applyToolClick(applyToolClick(state(null), "mute", 10), "mute", 12);
		s = applyToolClick(s, "hand", 11);
		s = applyToolClick(s, "arrow", 11);
		s = applyToolClick(s, "hand", 10);

		expect([...s.muted].sort()).toEqual([10, 12]);
		expect(s.soloId).toBe(11);
		// And un-soloing restores exactly the mutes the listener set.
		const released = reconcileSolo({ ...s, soloId: null }, []);
		expect([...released.muted].sort()).toEqual([10, 12]);
	});
});

describe("releaseLaneMute", () => {
	// Story 040's third rule: clicking a player while the LIVE lane is muted
	// clears the lane mute and unmutes ONLY that player. The lane flag is not a
	// mute of its own, so it has to be materialised into per-card mutes on the
	// way out — dropping it without doing so would bring the lane back at once.

	it("leaves the clicked card audible", () => {
		const next = releaseLaneMute(INITIAL_AUDIO_STATE, ALL, 11);
		expect(isAudible(next, 11, "live")).toBe(true);
	});

	it("keeps every other card in the lane silent", () => {
		const next = releaseLaneMute(INITIAL_AUDIO_STATE, ALL, 11);
		expect(isAudible(next, 10, "live")).toBe(false);
		expect(isAudible(next, 12, "live")).toBe(false);
		expect([...next.muted].sort()).toEqual([10, 12]);
	});

	it("silences exactly one card in the mix, not zero and not all of them", () => {
		const next = releaseLaneMute(INITIAL_AUDIO_STATE, ALL, 12);
		expect(ALL.filter((i) => isAudible(next, i.id, "live")).map((i) => i.id)).toEqual([12]);
	});

	it("unmutes a card that was already muted before the lane was", () => {
		// The listener clicked THIS card; a mute from ten minutes ago is not a
		// reason to hand them back silence.
		const next = releaseLaneMute(state(null, [11]), ALL, 11);
		expect(isAudible(next, 11, "live")).toBe(true);
	});

	it("releases the solo along with the lane mute", () => {
		// effectiveMutedIds keeps a solo target audible in spite of its own mute,
		// so a solo left pointing elsewhere would mean the card the listener
		// clicked stayed silent and a different one did not.
		const next = releaseLaneMute(state(10), ALL, 11);
		expect(next.soloId).toBeNull();
		expect(isAudible(next, 10, "live")).toBe(false);
	});

	it("keeps mutes for cards outside the lane it was handed", () => {
		// The shell hands it LANE membership, and a clip in another lane is not
		// this instruction's business.
		const next = releaseLaneMute(state(null, [99]), ALL, 10);
		expect(next.muted.has(99)).toBe(true);
	});

	it("mutes the whole lane when the clicked card is not in it", () => {
		// Not a case the shell produces, but the honest reading: nothing was
		// named, so nothing is excepted — silence, rather than a lane that
		// quietly came back.
		const next = releaseLaneMute(INITIAL_AUDIO_STATE, ALL, 404);
		expect(ALL.some((i) => isAudible(next, i.id, "live"))).toBe(false);
	});

	it("arms the auto-solo hand-over, unlike the mute tool", () => {
		// Story 039 lets a mute DISARM auto-solo, so the Live lane can be
		// silenced without the next card being promoted into the gap. This is the
		// other case: the listener named a card to hear, so reconcileSolo is meant
		// to answer by pointing the solo at it.
		const next = releaseLaneMute(state(null, [10, 11, 12]), ALL, 11);
		expect(next.autoSoloSuspended).toBe(false);
		expect(reconcileSolo(next, ALL).soloId).toBe(11);
	});

	it("leaves the lane quiet once the card it was handed has gone", () => {
		// Everything else is an explicit mute now, and autoSoloTarget skips those
		// — so the clip ending is silence rather than a sibling the listener
		// already silenced coming back.
		const next = releaseLaneMute(INITIAL_AUDIO_STATE, ALL, 11);
		const afterItEnds = reconcileSolo({ ...next, soloId: 11 }, [A, C]);
		expect(afterItEnds.soloId).toBeNull();
	});

	it("does not mutate the state it was given", () => {
		// The shell feeds this straight into React state; editing the old Set in
		// place would make the two indistinguishable and skip the render.
		const before = state(10, [12]);
		releaseLaneMute(before, ALL, 11);
		expect(before.soloId).toBe(10);
		expect([...before.muted]).toEqual([12]);
	});
});

describe("autoSoloTarget", () => {
	const nowMs = t("2001-09-11T13:03:00.000Z");

	it("is the earliest start_date in the mix", () => {
		expect(autoSoloTarget(mixAt(nowMs), new Set())).toBe(10);
	});

	it("breaks a start_date tie on the lowest id", () => {
		// Radio clips genuinely share a start second; without a tie-break the
		// answer would depend on the arrival order of the mp3 frames.
		const tied = [
			item({ id: 42, start_date: "2001-09-11T13:00:00.000Z" }),
			item({ id: 7, start_date: "2001-09-11T13:00:00.000Z" }),
			item({ id: 19, start_date: "2001-09-11T13:00:00.000Z" }),
		];
		expect(autoSoloTarget(tied, new Set())).toBe(7);
		expect(autoSoloTarget([...tied].reverse(), new Set())).toBe(7);
	});

	it("skips a card the listener muted", () => {
		// Auto-solo must never force sound out of a card that was explicitly
		// silenced — that is the one state the listener asked for by name.
		expect(autoSoloTarget(mixAt(nowMs), new Set([10]))).toBe(11);
		expect(autoSoloTarget(mixAt(nowMs), new Set([10, 11]))).toBe(12);
	});

	it("is null when the mix is empty or entirely muted", () => {
		expect(autoSoloTarget([], new Set())).toBeNull();
		expect(autoSoloTarget(mixAt(nowMs), new Set([10, 11, 12]))).toBeNull();
	});

	it("does not read the tz-less Directus form as local time", () => {
		const tzLess = [
			item({ id: 2, start_date: "2001-09-11T13:05:00" }),
			item({ id: 1, start_date: "2001-09-11T13:06:00" }),
		];
		expect(autoSoloTarget(tzLess, new Set())).toBe(2);
	});
});

describe("startup: exactly one LIVE card is audible", () => {
	const nowMs = t("2001-09-11T13:03:00.000Z");

	it("proves the gap is real: the bare initial state leaves every card audible", () => {
		// soloId null + nothing muted means isAudible is true for the whole mix.
		// The invariant is not free — reconcileSolo is what buys it.
		const mix = mixAt(nowMs);
		expect(mix.filter((i) => isAudible(INITIAL_AUDIO_STATE, i.id, "live"))).toHaveLength(3);
	});

	it("reconciles the initial state down to exactly one audible card", () => {
		const mix = mixAt(nowMs);
		const started = reconcileSolo(INITIAL_AUDIO_STATE, mix);
		const audible = mix.filter((i) => isAudible(started, i.id, "live"));
		expect(audible.map((i) => i.id)).toEqual([10]);
	});
});

describe("reconcileSolo", () => {
	const nowMs = t("2001-09-11T13:03:00.000Z");

	it("leaves a live solo target alone, object identity included", () => {
		const before = state(12);
		expect(reconcileSolo(before, mixAt(nowMs))).toBe(before);
	});

	it("proves the hazard: a stale solo target silences the entire mix", () => {
		// effectiveMutedIds(muted, soloId, playingIds) excepts the solo target from
		// the mute — and if the target is not in playingIds, nothing is excepted.
		// Every card goes silent with no visible cause. This is the state
		// reconcileSolo exists to make unreachable.
		const stale = state(10);
		const mix = mixAt(nowMs, { ended: new Set([10]) });
		expect(somethingAudible(stale, mix)).toBe(false);
	});

	describe("releases the solo on each of the three exits", () => {
		it("exit 1: the soloed clip's element reported ended", () => {
			// Playback can finish before the clock passes end_date — a trimmed file,
			// or a source shorter than its scheduled window. The card is still LIVE
			// by the clock and still on screen; there is simply no more audio.
			const mix = mixAt(nowMs, { ended: new Set([10]) });
			const next = reconcileSolo(state(10), mix);

			expect(next.soloId).not.toBe(10);
			expect(somethingAudible(next, mix)).toBe(true);
		});

		it("exit 2: the soloed card migrated out of LIVE as the clock moved", () => {
			// Forward past its end_date, and backward across its start on a seek —
			// both drop it out of the live lane while the card still exists.
			const forward = mixAt(t("2001-09-11T13:05:00.000Z"));
			expect(forward.map((i) => i.id)).not.toContain(10);
			const afterForward = reconcileSolo(state(10), forward);
			expect(afterForward.soloId).not.toBe(10);
			expect(somethingAudible(afterForward, forward)).toBe(true);

			const rewound = mixAt(t("2001-09-11T13:01:30.000Z"));
			expect(rewound.map((i) => i.id)).not.toContain(12);
			const afterRewind = reconcileSolo(state(12), rewound);
			expect(afterRewind.soloId).not.toBe(12);
			expect(somethingAudible(afterRewind, rewound)).toBe(true);
		});

		it("exit 3: a tag filter hid the soloed card", () => {
			// The clip is playing perfectly well; the listener just narrowed the
			// grid. Staying soloed on a card nobody can see is how the mix goes
			// silent with nothing on screen to explain it.
			const mix = mixAt(nowMs, { hidden: new Set([10]) });
			const next = reconcileSolo(state(10), mix);

			expect(next.soloId).not.toBe(10);
			expect(somethingAudible(next, mix)).toBe(true);
		});
	});

	it("re-runs the auto-solo rule, so the replacement is deterministic", () => {
		const mix = mixAt(nowMs, { hidden: new Set([10]) });
		expect(reconcileSolo(state(10), mix).soloId).toBe(11);
	});

	it("hands the mix back when there is nothing left to solo", () => {
		// An empty mix is silence because there is no audio, not because a stale
		// target is muting everything — soloId must not be left pointing at a ghost.
		expect(reconcileSolo(state(10), []).soloId).toBeNull();
	});

	it("keeps the manual mutes while it swaps the target", () => {
		const next = reconcileSolo(state(10, [12]), mixAt(nowMs, { hidden: new Set([10]) }));
		expect(next.soloId).toBe(11);
		expect([...next.muted]).toEqual([12]);
	});

	it("does not resurrect a solo the listener muted away", () => {
		// mute-on-the-solo-target releases the solo, and the next reconcile must
		// never point it back at the card just silenced.
		const muted = applyToolClick(state(10), "mute", 10);
		const next = reconcileSolo(muted, mixAt(nowMs));
		expect(next.soloId).not.toBe(10);
		expect(isAudible(next, 10, "live")).toBe(false);
	});
});

// Story 039. Auto-solo is a HAND-OVER rule, not a "something must always be
// playing" rule: the plan states it as "re-run it whenever the current target
// leaves LIVE", plus the startup case where there is no focus yet. Firing it on
// a MUTE as well is what made the Live lane impossible to quieten — every press
// of mute promoted the next card, so there was always something audible.
//
// Both paths arrive at reconcileSolo with no solo target, so telling them apart
// is the whole of the fix: an ENDED target is one that left `mix`, a MUTED one
// is one the listener silenced on purpose. applyToolClick records the second,
// and reconcileSolo is the only reader.
describe("muting the focus, as against the focus ending", () => {
	const nowMs = t("2001-09-11T13:03:00.000Z");

	/** Every live card muted in turn, reconciling between clicks as the shell does. */
	function silenceEveryCard(): AudioState {
		let s = reconcileSolo(INITIAL_AUDIO_STATE, mixAt(nowMs));
		for (const card of mixAt(nowMs)) {
			s = reconcileSolo(applyToolClick(s, "mute", card.id), mixAt(nowMs));
		}
		return s;
	}

	it("does not promote another card when the listener mutes the focused one", () => {
		const muted = applyToolClick(state(10), "mute", 10);

		const next = reconcileSolo(muted, mixAt(nowMs));

		expect(next.soloId).toBeNull();
		expect(isAudible(next, 10, "live")).toBe(false);
	});

	it("still promotes another card when the focused clip ENDS", () => {
		// The mutation check for the assertion above. The two paths shared one
		// mechanism, so a fix that suppressed the hand-over outright would strand
		// the lane on a clip with no audio left — silence with nothing on screen
		// to explain it, which is the hazard reconcileSolo exists for.
		const mix = mixAt(nowMs, { ended: new Set([10]) });

		const next = reconcileSolo(state(10), mix);

		expect(next.soloId).toBe(11);
		expect(somethingAudible(next, mix)).toBe(true);
	});

	it("leaves the whole lane silent once every card is muted", () => {
		const silenced = silenceEveryCard();

		expect(somethingAudible(silenced, mixAt(nowMs))).toBe(false);
		// And it stays silent: reconcile runs on every visible-mix change, once a
		// second, and used to pick a fresh target on each pass.
		expect(somethingAudible(reconcileSolo(silenced, mixAt(nowMs)), mixAt(nowMs))).toBe(
			false,
		);
	});

	it("keeps every per-card mute when a new clip arrives in the lane", () => {
		const silenced = silenceEveryCard();
		const arriving = item({
			id: 13,
			source: "PAPD",
			start_date: "2001-09-11T13:02:30.000Z",
			end_date: "2001-09-11T13:10:00.000Z",
		});

		const next = reconcileSolo(silenced, [...mixAt(nowMs), arriving]);

		// No focus is invented for it. Soloing the arrival would silence the
		// three cards a second time — by solo rather than by their own mute —
		// and unmuting one would then leave it inaudible with its own button
		// reporting it as unmuted.
		expect(next.soloId).toBeNull();
		expect([...next.muted].sort((a, b) => a - b)).toEqual([10, 11, 12]);
		for (const id of [10, 11, 12]) expect(isAudible(next, id, "live")).toBe(false);
		// The new transmission is audible, because it is not one the listener
		// muted — mute is per card, and story 040's lane-level control is the
		// answer to "and everything that arrives from now on".
		expect(isAudible(next, 13, "live")).toBe(true);
	});

	it("resumes automatic hand-over as soon as the listener picks a focus again", () => {
		// Muting the focus says "stop choosing for me"; soloing a card says the
		// opposite, so the hand-over has to come back with it rather than staying
		// off for the rest of the session.
		const refocused = applyToolClick(applyToolClick(state(10), "mute", 10), "arrow", 11);

		const next = reconcileSolo(refocused, mixAt(nowMs, { ended: new Set([11]) }));

		expect(next.soloId).toBe(12);
	});

	it("does not disarm the hand-over when the muted card was not the focus", () => {
		// Muting a card that is already silent under someone else's solo is not
		// the listener releasing the focus, so 12 ending must still hand on.
		const muted = applyToolClick(state(12), "mute", 10);
		expect(muted.soloId).toBe(12);

		const next = reconcileSolo(muted, mixAt(nowMs, { ended: new Set([12]) }));

		// 10 is muted, so the hand-over skips it exactly as autoSoloTarget says.
		expect(next.soloId).toBe(11);
	});
});

// Issue #552 (post-merge follow-up). PR #554 fixed unmute-clicking a
// non-solo card so that BOTH it and the outgoing solo target stay audible —
// but shipped with `autoSoloSuspended` left false on that path, on the
// (wrong) theory that it should read the same as releaseLaneMute's "the
// listener named a focus" re-arm. It does not: naming a focus leaves exactly
// ONE card audible, which is the state auto-solo exists to reach on its own,
// so re-arming there is harmless. This path leaves TWO cards audible with no
// solo, which auto-solo has never been able to represent — reconcileSolo
// only ever produces "one card" (a soloId) or "whatever `muted` says", never
// "pick one of these two." Left armed, the shell's reconcileSolo effect (kept
// on every visible-mix change, which includes the once-a-second reference
// churn from the ticking clock even when membership hasn't changed) picked a
// winner within about a second and the other card fell silent again.
describe("unmuting a second card while soloed keeps BOTH audible (issue #552)", () => {
	const nowMs = t("2001-09-11T13:03:00.000Z");

	it("survives one reconcileSolo pass with the same mix", () => {
		const soloed = applyToolClick(state(null), "arrow", 10);
		const next = applyToolClick(soloed, "unmute", 11, ALL);

		const reconciled = reconcileSolo(next, mixAt(nowMs));

		expect(reconciled.soloId).toBeNull();
		expect(isAudible(reconciled, 10, "live")).toBe(true);
		expect(isAudible(reconciled, 11, "live")).toBe(true);
		expect(isAudible(reconciled, 12, "live")).toBe(false);
	});

	it("survives a reconcileSolo pass against a NEW mix array with the same membership", () => {
		// This is the reproduction that actually matches the bug report: the
		// RadioTraffic shell recomputes `visible.live` from the virtual clock on
		// every tick, so the array `reconcileSolo` sees is a fresh reference each
		// time even when no card entered or left LIVE. A fix that only happened
		// to work because a test reused the same array/object identities would
		// pass the case above and still fail here.
		const soloed = applyToolClick(state(null), "arrow", 10);
		const next = applyToolClick(soloed, "unmute", 11, ALL);

		const freshMix = mixAt(nowMs).map((mediaItem) => ({ ...mediaItem }));
		expect(freshMix).not.toBe(mixAt(nowMs));
		const reconciled = reconcileSolo(next, freshMix);

		expect(reconciled.soloId).toBeNull();
		expect(isAudible(reconciled, 10, "live")).toBe(true);
		expect(isAudible(reconciled, 11, "live")).toBe(true);
	});

	it("stays that way across several ticks, not just the first", () => {
		const soloed = applyToolClick(state(null), "arrow", 10);
		let s = applyToolClick(soloed, "unmute", 11, ALL);
		for (let tick = 0; tick < 5; tick++) {
			s = reconcileSolo(
				s,
				mixAt(nowMs).map((mediaItem) => ({ ...mediaItem })),
			);
		}

		expect(s.soloId).toBeNull();
		expect(isAudible(s, 10, "live")).toBe(true);
		expect(isAudible(s, 11, "live")).toBe(true);
	});
});
