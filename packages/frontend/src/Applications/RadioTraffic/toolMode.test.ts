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

		it("releases the solo when the muted card IS the solo target", () => {
			// Otherwise the click is a silent no-op: effectiveMutedIds keeps the solo
			// target audible in spite of its manual mute, so the one card the
			// listener is actually hearing would be the one card they cannot mute.
			const next = applyToolClick(state(11, []), "mute", 11);
			expect(next.soloId).toBeNull();
			expect(isAudible(next, 11, "live")).toBe(false);
			expect([...next.muted]).toEqual([11]);
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
		// mute-on-the-solo-target releases the solo; the next reconcile must move
		// on to another card rather than re-soloing the one just silenced.
		const muted = applyToolClick(state(10), "mute", 10);
		const next = reconcileSolo(muted, mixAt(nowMs));
		expect(next.soloId).toBe(11);
		expect(isAudible(next, 10, "live")).toBe(false);
	});
});
