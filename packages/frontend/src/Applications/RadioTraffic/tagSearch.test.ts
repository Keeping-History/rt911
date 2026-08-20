import { describe, expect, it, vi } from "vitest";
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";
import { buildSearchIndex, searchTags } from "./tagSearch";

/** A vocabulary row as the wire delivers it: `namespace:value` split out. */
function def(tag: string): TagDef {
	const i = tag.indexOf(":");
	return { tag, namespace: tag.slice(0, i), value: tag.slice(i + 1) };
}

/**
 * Four values chosen so every ranking question has an answer here: `UAL175`
 * and `ual93` both start with "ual" in different cases, `n591ual` only
 * contains it, and `aal11` answers neither.
 */
const FLIGHTS = [
	def("aircraft:UAL175"),
	def("aircraft:aal11"),
	def("aircraft:n591ual"),
	def("aircraft:ual93"),
];

const values = (tags: TagDef[]) => tags.map((t) => t.value);

/**
 * 377 aircraft values — the live cardinality of the largest namespace
 * (verified against the cluster). The four hijacked flights are named and the
 * rest are shaped like the callsigns around them; nothing below cares what
 * they say, only that there are as many of them as the app really has.
 */
const HIJACKED = ["aal11", "ual175", "aal77", "ual93"];
const CARRIERS = ["aal", "ual", "dal", "swa", "cof", "nwa", "usa", "twa"];

function liveSizedAircraft(): TagDef[] {
	const vals = [...HIJACKED];
	for (let i = vals.length; i < 377; i++) {
		vals.push(`${CARRIERS[i % CARRIERS.length]}${100 + i}`);
	}
	return vals.map((v) => def(`aircraft:${v}`));
}

describe("searchTags", () => {
	it("matches case-insensitively on value, in both directions", () => {
		const index = buildSearchIndex(FLIGHTS);
		// Lowercase query against an uppercase value, and the reverse.
		expect(values(searchTags(index, "ual175"))).toEqual(["UAL175"]);
		expect(values(searchTags(index, "UAL93"))).toEqual(["ual93"]);
		expect(values(searchTags(index, "AaL11"))).toEqual(["aal11"]);
	});

	it("ranks prefix matches above substring matches", () => {
		// UAL175 and ual93 start with the query; n591ual merely contains it. A
		// pilot typing a callsign wants the callsign, not the tail number that
		// happens to end in it.
		const index = buildSearchIndex(FLIGHTS);
		expect(values(searchTags(index, "ual"))).toEqual(["UAL175", "ual93", "n591ual"]);
	});

	it("keeps the server's order within each rank band", () => {
		// The vocabulary arrives pre-ordered by `sort NULLS LAST, tag` and the
		// column is not on the wire (see tagFilter's groupVocabulary) — the only
		// thing search may reorder is prefix ahead of substring.
		const index = buildSearchIndex([
			def("aircraft:ual93"),
			def("aircraft:n591ual"),
			def("aircraft:UAL175"),
			def("aircraft:ual11"),
		]);
		expect(values(searchTags(index, "ual"))).toEqual([
			"ual93",
			"UAL175",
			"ual11",
			"n591ual",
		]);
	});

	it("returns everything for an empty query, in the order it was given", () => {
		const index = buildSearchIndex(FLIGHTS);
		expect(values(searchTags(index, ""))).toEqual([
			"UAL175",
			"aal11",
			"n591ual",
			"ual93",
		]);
	});

	it("treats a whitespace-only query as empty", () => {
		// A pasted value arrives with padding around it, and no aircraft value
		// contains a space — so trimming can only help. A blank field showing
		// nothing would read as "no such tag" rather than "type something".
		const index = buildSearchIndex(FLIGHTS);
		expect(searchTags(index, "   ")).toHaveLength(FLIGHTS.length);
		expect(values(searchTags(index, "  ual93  "))).toEqual(["ual93"]);
	});

	it("matches the value, not the namespaced tag", () => {
		// Every row in a picker shares one namespace, so matching `tag` would
		// make "air" return all 377 of them — a search that answers nothing.
		const index = buildSearchIndex(FLIGHTS);
		expect(searchTags(index, "aircraft")).toEqual([]);
		expect(searchTags(index, "aircraft:ual93")).toEqual([]);
	});

	it("returns nothing when a query matches nothing", () => {
		expect(searchTags(buildSearchIndex(FLIGHTS), "zzz")).toEqual([]);
	});

	it("returns no results from an empty vocabulary", () => {
		const index = buildSearchIndex([]);
		expect(searchTags(index, "")).toEqual([]);
		expect(searchTags(index, "ual")).toEqual([]);
	});

	it("lists a row with no value but never matches it", () => {
		// `value` is optional on TagDef only because Go's omitempty drops an
		// empty string. Such a row must still be checkable in the picker, so it
		// is listed — it just cannot answer a search.
		const index = buildSearchIndex([{ tag: "aircraft:", namespace: "aircraft" }]);
		expect(searchTags(index, "")).toHaveLength(1);
		expect(searchTags(index, "a")).toEqual([]);
	});
});

describe("buildSearchIndex", () => {
	it("lowercases each value once at build time and never again per keystroke", () => {
		// The whole reason a prebuilt index exists: 377 values are re-filtered on
		// every keystroke, so the lowercasing must happen once, not 377 times per
		// character. Counting the reads is the only thing that tells a prebuilt
		// index apart from a `values.filter(v => v.value.toLowerCase()...)` that
		// returns identical results — so count them, on the real cardinality.
		const rows = liveSizedAircraft();
		expect(rows).toHaveLength(377);
		expect(new Set(rows.map((r) => r.tag)).size).toBe(377);

		let valueReads = 0;
		const watched = rows.map((row) => ({
			tag: row.tag,
			namespace: row.namespace,
			get value() {
				valueReads++;
				return row.value;
			},
		})) as TagDef[];

		const lower = vi.spyOn(String.prototype, "toLowerCase");
		let readsAfterBuild = 0;
		let loweredAtBuild = 0;
		let readsAfterTyping = 0;
		let loweredWhileTyping = 0;
		let hits: TagDef[] = [];
		// One realistic run of the field: a callsign typed a character at a time.
		const keystrokes = ["a", "aa", "aal", "aal1", "aal11"];
		try {
			const index = buildSearchIndex(watched);
			readsAfterBuild = valueReads;
			loweredAtBuild = lower.mock.calls.length;

			for (const q of keystrokes) hits = searchTags(index, q);

			readsAfterTyping = valueReads;
			loweredWhileTyping = lower.mock.calls.length - loweredAtBuild;
		} finally {
			// Assertions themselves lowercase strings; the counts must be frozen
			// before expect() runs or the spy measures vitest instead.
			lower.mockRestore();
		}

		// Building reads and lowercases every value exactly once.
		expect(readsAfterBuild).toBe(377);
		expect(loweredAtBuild).toBe(377);
		// Typing touches the raw vocabulary not at all…
		expect(readsAfterTyping).toBe(readsAfterBuild);
		// …and lowercases only the query. Re-scanning the raw array per keystroke
		// would be 377 × 5 = 1885 calls here.
		expect(loweredWhileTyping).toBeLessThanOrEqual(keystrokes.length);
		// And it is a real search, not an empty one that trivially reads nothing:
		// the hijacked flight plus the one generated callsign that extends it,
		// still in the order they were given.
		expect(values(hits)).toEqual(["aal11", "aal116"]);
	});
});
