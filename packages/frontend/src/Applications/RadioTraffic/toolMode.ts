// The modal tool palette, and the audio state its clicks edit.
//
// Radio Traffic is modal: a card click means whatever the active tool says it
// means. That is the whole reason this is a reducer rather than four handlers
// hung off the card — the card reports "I was clicked", and what happens to the
// mix is decided in one place, by a pure function, that a test can drive
// through every combination without rendering anything.
//
// The mix model itself is NOT new. radio-core/radioPlayback's effectiveMutedIds
// already defines what solo and per-item mute mean, ten consumers agree with
// it, and the tuner ships it. isAudible asks that same function about one card
// instead of inventing a second, subtly different answer.

import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { effectiveMutedIds } from "../radio-core/radioPlayback";
import { startMs } from "../radio-core/stationGrouping";
import type { Lane } from "./cardStatus";

export type Tool = "arrow" | "mute" | "unmute" | "hand";

/** Palette order, left to right. */
export const TOOLS: readonly Tool[] = ["arrow", "mute", "unmute", "hand"];

export const TOOL_LABELS: Record<Tool, string> = {
	arrow: "Solo",
	mute: "Mute",
	unmute: "Unmute",
	hand: "Move",
};

/**
 * Balloon help, one line per tool.
 *
 * Written as an instruction rather than a description: Radio Traffic is modal,
 * so the only thing worth telling a listener hovering the palette is what their
 * NEXT card click will do. The palette is not a manifest-described state field —
 * `describeAppState` documents `tool` as one persisted value, which is the wrong
 * granularity for four buttons that each mean a different action — so the copy
 * lives beside the labels and the glyphs it belongs with.
 */
export const TOOL_BALLOONS: Record<Tool, string> = {
	arrow: "Click a card to hear only that one. The rest of the live mix goes quiet until you pick another.",
	mute: "Click a card to silence it. It keeps playing on the clock, so unmuting it later picks up live rather than starting over.",
	unmute: "Click a silenced card to bring it back into the mix.",
	hand: "Drag cards to reorder them within their lane. Clicking changes nothing about what you hear.",
};

/**
 * Placeholder artwork. Deliberately one map of one character each so replacing
 * the glyphs is a single edit here — swap the strings for <img> imports the way
 * StationButtonContent does with its indicator lights, and nothing else moves.
 */
export const TOOL_GLYPHS: Record<Tool, string> = {
	arrow: "▲",
	mute: "●",
	unmute: "○",
	hand: "▦",
};

/** Which cards the listener can hear. `muted` is per card and survives a tool change. */
export interface AudioState {
	soloId: number | null;
	muted: ReadonlySet<number>;
	/**
	 * True when the listener has explicitly moved the mix away from the
	 * "exactly one card audible" default WITHOUT naming a new solo — either by
	 * muting the card a solo was pointing at (silencing the lane on purpose,
	 * story 039), or by unmuting a second card while a solo was active (asking
	 * to hear MORE than one at once, story 041 / issue #552). Both leave
	 * `soloId: null` looking identical to a solo target that simply left the
	 * mix on its own — clip ended, tag filter hid it, a seek carried it out of
	 * LIVE — and telling the two apart is the whole point of this flag:
	 * auto-solo replacing a clip that ENDED is the lane carrying on, and
	 * auto-solo overriding either of THESE is the lane ignoring what the
	 * listener just did to it. `reconcileSolo` runs on every visible-mix
	 * change, including the once-a-second reference churn from the ticking
	 * clock where membership hasn't actually changed — so "suspended" has to
	 * survive far more calls than the one click that set it.
	 *
	 * Cleared (re-armed) by naming a new focus (`arrow`) or by
	 * `releaseLaneMute` — both are the listener saying "this one card", which
	 * is exactly the state auto-solo exists to reach on its own, so there is
	 * nothing left for the suspension to protect.
	 *
	 * Optional because absent is the startup answer, which is what every state
	 * object built outside this module (the shell's initialiser, restoring the
	 * persisted mutes) means.
	 *
	 * Written only by applyToolClick and releaseLaneMute, read only by
	 * reconcileSolo.
	 */
	autoSoloSuspended?: boolean;
}

export const INITIAL_AUDIO_STATE: AudioState = {
	soloId: null,
	muted: new Set(),
	autoSoloSuspended: false,
};

/**
 * Can this card be heard right now?
 *
 * Only LIVE cards are in the mix: an UPCOMING card has no audio yet, and a
 * PREVIOUS one plays only when the listener starts it themselves, which is its
 * own thing and not part of the solo/mute model.
 *
 * The live answer is effectiveMutedIds asked about a one-card mix, which is
 * exact rather than approximate: with no solo it reports the manual mute, and
 * with a solo it keeps only the solo target — including when that target was
 * manually muted, so un-soloing restores the manual state untouched.
 */
export function isAudible(state: AudioState, itemId: number, lane: Lane): boolean {
	if (lane !== "live") return false;
	return !effectiveMutedIds([...state.muted], state.soloId, [itemId]).includes(itemId);
}

/**
 * The click, interpreted by the active tool. Returns the state object unchanged
 * when nothing moved — the shell feeds this straight back into React state, and
 * a fresh object per click would re-render the grid for no reason.
 *
 * `mix` is the LIVE, filter-visible mix — the same list `reconcileSolo` and
 * `releaseLaneMute` already take, and for the same reason: it is read by the
 * `mute` case when the card being muted IS the current solo target (see that
 * case below), and by the `unmute` case when the card being unmuted is NOT
 * the current solo target (see that case further down). Every other tool
 * ignores it, so callers that cannot hit either branch (tests exercising
 * `arrow`/`hand` alone, or `unmute` with no solo active) may omit it — the
 * default empty mix is only wrong for the cases that read it.
 */
export function applyToolClick(
	state: AudioState,
	tool: Tool,
	itemId: number,
	mix: readonly MediaItem[] = [],
): AudioState {
	switch (tool) {
		case "arrow": {
			if (state.soloId === itemId) return state;
			// Mutes are left exactly as they are: solo is a temporary override, and
			// releasing it must hand the listener back the mix they built.
			//
			// Naming a focus is also the listener asking for one, so it re-arms the
			// hand-over a mute had disarmed — otherwise a single mute would switch
			// auto-solo off for the rest of the session, and this card ending would
			// leave the lane with nothing in it.
			return { soloId: itemId, muted: state.muted, autoSoloSuspended: false };
		}
		case "mute": {
			if (state.muted.has(itemId)) return state;
			const muted = new Set(state.muted);
			muted.add(itemId);
			// Muting a card that is not the solo target changes nothing about the
			// focus — under a solo it was already inaudible, and with no solo it is
			// an ordinary per-card mute.
			if (state.soloId !== itemId) return { ...state, muted };
			// Muting the solo target releases the solo — but every OTHER live card
			// was only audible because the solo excepted it from an implicit mute,
			// not because of any mute of its own. Dropping the solo without
			// materialising that implicit silence into explicit per-card mutes is
			// what let muting the one card a listener was actually listening to
			// reopen the whole board: with the solo gone and nothing else in
			// `muted`, effectiveMutedIds has nothing left to silence. So every other
			// mix member is folded into `muted` here, the same move releaseLaneMute
			// makes in the opposite direction (naming one card to hear materialises
			// everyone else's implicit audibility into an explicit mute).
			for (const item of mix) {
				if (item.id !== itemId) muted.add(item.id);
			}
			// The release is RECORDED, because it is the listener quietening the
			// lane rather than a clip running out: reconcileSolo must not answer it
			// by promoting the next card, which is what made the Live lane
			// impossible to silence.
			return { soloId: null, muted, autoSoloSuspended: true };
		}
		case "unmute": {
			// A solo silences every OTHER live card implicitly, via effectiveMutedIds'
			// override, not through `muted` — so unmute-clicking one of those cards
			// used to be a silent no-op: it was never in `muted` to begin with. The
			// fix mirrors "muting the solo target" above and releaseLaneMute: naming
			// this card materialises the solo's implicit silence into explicit
			// per-card mutes for every OTHER mix member, so each becomes independently
			// clickable again, while this card and the outgoing solo target both stay
			// audible.
			if (state.soloId !== null && state.soloId !== itemId) {
				const muted = new Set(state.muted);
				muted.delete(itemId);
				muted.delete(state.soloId);
				for (const item of mix) {
					if (item.id !== itemId && item.id !== state.soloId) muted.add(item.id);
				}
				// This is the listener asking for MORE cards to be heard, not for
				// quiet — but reconcileSolo cannot read that off `soloId: null` alone,
				// and it re-runs on every visible-mix reference change, including the
				// once-a-second churn from the ticking clock where membership hasn't
				// actually changed. Left un-suspended, autoSoloTarget would pick ONE of
				// these two newly-audible cards on the very next tick and fold the
				// other back into the solo's implicit mute — issue #552. Suspending
				// auto-solo is the same move the mute branch above makes when IT
				// releases a solo, for the same reason; the two differ in why the lane
				// stopped being single-card, not in what reconcileSolo owes it.
				return { soloId: null, muted, autoSoloSuspended: true };
			}
			if (!state.muted.has(itemId)) return state;
			const muted = new Set(state.muted);
			muted.delete(itemId);
			// The hand-over stays disarmed. Unmuting is not a request for a focus —
			// with no solo the card is audible on its own — and re-arming here would
			// let the next reconcile solo some OTHER card, silencing the very one
			// the listener just brought back.
			return { ...state, muted };
		}
		case "hand":
			// The drag-reorder tool. It moves cards, not audio.
			return state;
	}
}

/**
 * The per-card mutes a LANE mute becomes when the listener picks one card to
 * hear again (story 040).
 *
 * The lane flag and the per-card set answer different questions — "silence this
 * lane, including whatever arrives next" against "silence these clips" — and
 * clicking a card is the moment the first turns into the second: the listener
 * has just named the one thing they want to hear, so every OTHER clip in the
 * lane becomes an explicit mute and the flag has nothing left to say. Written
 * this way round rather than as "clear the flag, unmute one" because the flag
 * is not a mute of its own: dropping it without materialising it would bring
 * the whole lane back at once.
 *
 * `lane` is the lane's MEMBERSHIP, not the cards a filter happens to be showing
 * — a clip hidden by a tag filter is still playing on the clock, and leaving it
 * out here would let it be the one thing still audible.
 */
export function releaseLaneMute(
	state: AudioState,
	lane: readonly MediaItem[],
	itemId: number,
): AudioState {
	const muted = new Set(state.muted);
	for (const item of lane) {
		if (item.id === itemId) muted.delete(item.id);
		else muted.add(item.id);
	}
	// The solo goes with it. The listener has just said which card they want,
	// and a solo left pointing at a different one would contradict them —
	// effectiveMutedIds keeps a solo target audible in spite of its mute, so the
	// card they clicked would stay silent and another would not.
	//
	// The hand-over is ARMED, which is the opposite of what the mute and unmute
	// tools do with the same field (stories 039/041): naming a card to hear is a
	// request for a focus, so reconcileSolo is meant to answer it by pointing
	// the solo at the one card this just left unmuted. Leaving it suspended here
	// would leave soloId null against a lane of mutes — audible, but only until
	// the clicked clip ends, at which point nothing would take over.
	return { soloId: null, muted, autoSoloSuspended: false };
}

/**
 * The card that plays when the listener has not chosen one.
 *
 * "Exactly one LIVE player audible by default" is not free: with no solo and
 * nothing muted every live card is audible, so the default has to be stated.
 * Earliest start_date, tie-broken by the lowest id — clips genuinely share a
 * start second, and without the tie-break the answer would depend on the order
 * mp3 frames happened to arrive.
 *
 * Manually muted cards are skipped. Auto-solo exists to avoid silence, not to
 * override the one instruction the listener gave explicitly; an all-muted mix
 * returns null and is silent on purpose.
 */
export function autoSoloTarget(
	mix: readonly MediaItem[],
	muted: ReadonlySet<number>,
): number | null {
	let best: MediaItem | null = null;
	let bestStart = 0;
	for (const item of mix) {
		if (muted.has(item.id)) continue;
		const start = startMs(item);
		if (best === null || start < bestStart || (start === bestStart && item.id < best.id)) {
			best = item;
			bestStart = start;
		}
	}
	return best?.id ?? null;
}

/**
 * Point the solo at a card that is actually in the mix.
 *
 * This is the guard against the one failure mode of the solo model:
 * effectiveMutedIds mutes everything playing *except* the solo target, so if
 * the target is not playing, nothing is excepted and the whole grid goes silent
 * with nothing on screen to explain why. Three ordinary things reach that state
 * — the soloed clip's audio ends, the soloed card leaves LIVE as the clock
 * moves (forwards past its end, or backwards over its start on a seek), and a
 * tag filter hides it — so the release is not an edge case, it is the normal
 * course of a session. The tuner carries the same effect (RadioScanner.tsx:
 * "so the rest of the mix comes back rather than staying silent").
 *
 * `mix` is the LIVE, filter-visible, still-playing cards; each of those three
 * exits is simply an item no longer being in it. Re-running autoSoloTarget
 * rather than clearing to null keeps the "exactly one audible" invariant across
 * the handover, and returning `state` untouched when the target is still there
 * keeps this safe to call on every clock tick.
 *
 * Which makes auto-solo a HAND-OVER rule and not a "something must always be
 * playing" one, and the distinction is load bearing. There are other ways to
 * arrive here with no target that are NOT a clip quietly leaving the mix —
 * the listener MUTED the solo target (materialising its implicit silence into
 * an explicit mute over the whole lane), or UNMUTED a second card while a
 * solo was active (asking to hear more than one at once) — and answering
 * either the same way as a clip ending is why the Live lane could not be
 * silenced, or why an unmute stopped sticking: every subsequent reconcile
 * promoted a card the listener had just decided about, chasing a focus that
 * kept moving out from under them. Both are recorded on the state (see
 * `autoSoloSuspended`) precisely so this function can decline to pick a new
 * target, and the stale-target clear below still runs either way, because a
 * solo pointing at a ghost silences everything.
 */
export function reconcileSolo(state: AudioState, mix: readonly MediaItem[]): AudioState {
	if (state.soloId !== null && mix.some((i) => i.id === state.soloId)) return state;
	const soloId = state.autoSoloSuspended ? null : autoSoloTarget(mix, state.muted);
	if (soloId === state.soloId) return state;
	return { ...state, soloId };
}
