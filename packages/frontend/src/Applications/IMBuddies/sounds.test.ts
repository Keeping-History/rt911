import { describe, expect, it } from "vitest";
import { IM_SOUNDS, presenceSounds } from "./sounds";

const m = (o: Record<number, boolean>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

describe("presenceSounds", () => {
	it("plays nothing for the first roster", () => {
		// Connecting at 9:15 with two buddies already online must not fire two
		// door-opens. Sounds mark a CHANGE, and the first roster is not a change.
		expect(presenceSounds(null, m({ 1: true, 2: true }))).toEqual([]);
	});

	it("plays the door opening when a buddy comes online", () => {
		expect(presenceSounds(m({ 1: false }), m({ 1: true }))).toEqual([IM_SOUNDS.buddyIn]);
	});

	it("plays the door closing when a buddy goes offline", () => {
		expect(presenceSounds(m({ 1: true }), m({ 1: false }))).toEqual([IM_SOUNDS.buddyOut]);
	});

	it("plays nothing when nothing changed", () => {
		expect(presenceSounds(m({ 1: true, 2: false }), m({ 1: true, 2: false }))).toEqual([]);
	});

	it("plays once per buddy that changed", () => {
		const got = presenceSounds(m({ 1: false, 2: true }), m({ 1: true, 2: false }));
		expect(got).toHaveLength(2);
		expect(got).toContain(IM_SOUNDS.buddyIn);
		expect(got).toContain(IM_SOUNDS.buddyOut);
	});

	it("ignores a buddy that appeared for the first time", () => {
		// A new profile added mid-session is not someone walking through a door.
		expect(presenceSounds(m({ 1: true }), m({ 1: true, 2: true }))).toEqual([]);
	});

	it("ignores a buddy that vanished from the roster entirely", () => {
		// chat_roster is a wholesale replace, so an entry can disappear for
		// reasons unrelated to a person leaving (narrowed roster, a smaller list
		// on reconnect). That is configuration changing, not a door closing, so
		// it earns no buddyOut chime — only entries present in BOTH maps can
		// change state.
		expect(presenceSounds(m({ 1: true, 2: true }), m({ 1: true }))).toEqual([]);
	});
});
