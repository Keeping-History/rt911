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
}

export const INITIAL_AUDIO_STATE: AudioState = { soloId: null, muted: new Set() };

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
 */
export function applyToolClick(state: AudioState, tool: Tool, itemId: number): AudioState {
	switch (tool) {
		case "arrow": {
			if (state.soloId === itemId) return state;
			// Mutes are left exactly as they are: solo is a temporary override, and
			// releasing it must hand the listener back the mix they built.
			return { soloId: itemId, muted: state.muted };
		}
		case "mute": {
			if (state.muted.has(itemId)) return state;
			const muted = new Set(state.muted);
			muted.add(itemId);
			// Muting the solo target releases the solo. Without this the click is a
			// silent no-op — effectiveMutedIds keeps the solo target audible in spite
			// of its manual mute, so the one card the listener is actually hearing
			// would be the one card they could not silence.
			return { soloId: state.soloId === itemId ? null : state.soloId, muted };
		}
		case "unmute": {
			if (!state.muted.has(itemId)) return state;
			const muted = new Set(state.muted);
			muted.delete(itemId);
			return { soloId: state.soloId, muted };
		}
		case "hand":
			// The drag-reorder tool. It moves cards, not audio.
			return state;
	}
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
 */
export function reconcileSolo(state: AudioState, mix: readonly MediaItem[]): AudioState {
	if (state.soloId !== null && mix.some((i) => i.id === state.soloId)) return state;
	const soloId = autoSoloTarget(mix, state.muted);
	if (soloId === state.soloId) return state;
	return { soloId, muted: state.muted };
}
