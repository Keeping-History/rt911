import { describe, expect, it } from "vitest";
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";
import {
	groupVocabulary,
	isTapeTier,
	LARGE_NAMESPACES,
	matchesFilter,
	UNKNOWN_TIER_TAG,
	withUnknownTier,
} from "./tagFilter";

/** A vocabulary row as the wire delivers it: `namespace:value` split out. */
function def(tag: string): TagDef {
	const i = tag.indexOf(":");
	return { tag, namespace: tag.slice(0, i), value: tag.slice(i + 1) };
}

/**
 * The live mp3_tags cardinality, namespace by namespace (1131 rows total).
 * The three-row toy fixture the mock was drawn against never met a namespace
 * big enough for the grouping strategy to matter; this one does.
 */
const LIVE_CARDINALITY: [string, number][] = [
	["aircraft", 377],
	["facility", 372],
	["person", 339],
	["topic", 25],
	["role", 6],
	["agency", 5],
	["link", 5],
	["tier", 2],
];

/** 1131 rows shaped like the real table, in the server's `tag` order. */
function liveSizedVocabulary(): TagDef[] {
	return LIVE_CARDINALITY.flatMap(([namespace, count]) =>
		Array.from({ length: count }, (_, i) =>
			def(`${namespace}:${String(i).padStart(4, "0")}`),
		),
	);
}

describe("groupVocabulary", () => {
	it("groups the live-sized vocabulary into its 8 namespaces", () => {
		const groups = groupVocabulary(liveSizedVocabulary());
		expect(groups.map((g) => [g.namespace, g.values.length])).toEqual(
			LIVE_CARDINALITY,
		);
		expect(groups.reduce((n, g) => n + g.values.length, 0)).toBe(1131);
	});

	it("marks only aircraft, facility and person large", () => {
		// The three that open a picker instead of expanding inline — every one of
		// them has 300+ values, and none of the other five clears 25.
		expect([...LARGE_NAMESPACES].sort()).toEqual([
			"aircraft",
			"facility",
			"person",
		]);
		const large = groupVocabulary(liveSizedVocabulary())
			.filter((g) => g.large)
			.map((g) => g.namespace);
		expect(large).toEqual(["aircraft", "facility", "person"]);
		const small = groupVocabulary(liveSizedVocabulary())
			.filter((g) => !g.large)
			.map((g) => g.namespace);
		expect(small).toEqual(["topic", "role", "agency", "link", "tier"]);
	});

	it("preserves the server's `sort NULLS LAST, tag` order within a namespace", () => {
		// `sort` is curator-settable but deliberately absent from the wire (see
		// backend model.Tag): the server has already applied it. Re-sorting here
		// would throw a curator's ordering away, so the order that arrives is the
		// order that must come out. Here `topic:hijack` carries a sort and the
		// rest do not, which is why it precedes an alphabetically earlier value.
		const groups = groupVocabulary([
			def("topic:hijack"),
			def("topic:crash"),
			def("topic:evacuation"),
			def("tier:primary"),
		]);
		expect(groups[0].values.map((t) => t.value)).toEqual([
			"hijack",
			"crash",
			"evacuation",
		]);
		expect(groups.map((g) => g.namespace)).toEqual(["topic", "tier"]);
	});

	it("labels each group with its namespace, capitalised", () => {
		const groups = groupVocabulary([def("aircraft:aal11"), def("tier:primary")]);
		expect(groups.map((g) => g.label)).toEqual(["Aircraft", "Tier"]);
	});

	it("omits a row with no namespace rather than inventing an Other bucket", () => {
		// mp3_tags.namespace is NOT NULL, so this row cannot occur; the field is
		// optional only because Go's omitempty drops an empty string. There is no
		// un-namespaced group in the sidebar design for such a row to land in.
		const groups = groupVocabulary([
			{ tag: "orphan", value: "orphan" },
			def("topic:hijack"),
		]);
		expect(groups.map((g) => g.namespace)).toEqual(["topic"]);
	});

	it("groups a 300+ value namespace in a single pass", () => {
		// Grouping by scanning the vocabulary once per namespace would read every
		// row's namespace 8 times over. Counting the reads is what tells the two
		// strategies apart — the group counts alone cannot.
		let reads = 0;
		const rows = liveSizedVocabulary().map((row) => ({
			tag: row.tag,
			value: row.value,
			get namespace() {
				reads++;
				return row.namespace;
			},
		})) as TagDef[];

		const groups = groupVocabulary(rows);

		expect(groups).toHaveLength(8);
		expect(groups[0].values.length).toBeGreaterThanOrEqual(300);
		expect(reads).toBe(rows.length);
	});

	it("returns no groups for an empty vocabulary", () => {
		expect(groupVocabulary([])).toEqual([]);
	});
});

describe("matchesFilter", () => {
	const zbw = def("facility:zbw");
	const zny = def("facility:zny");
	const aal11 = def("aircraft:aal11");

	it("matches every item when nothing is checked", () => {
		const none = new Set<string>();
		expect(matchesFilter([zbw], none)).toBe(true);
		expect(matchesFilter([], none)).toBe(true);
		expect(matchesFilter(undefined, none)).toBe(true);
	});

	it("ORs within a namespace: checking a second facility widens the result", () => {
		const oneFacility = new Set(["facility:zbw"]);
		expect(matchesFilter([zny], oneFacility)).toBe(false);

		const twoFacilities = new Set(["facility:zbw", "facility:zny"]);
		expect(matchesFilter([zny], twoFacilities)).toBe(true);
		expect(matchesFilter([zbw], twoFacilities)).toBe(true);
	});

	it("ANDs across namespaces: adding an aircraft narrows the result", () => {
		const oneFacility = new Set(["facility:zbw"]);
		expect(matchesFilter([zbw], oneFacility)).toBe(true);

		const facilityAndAircraft = new Set(["facility:zbw", "aircraft:aal11"]);
		expect(matchesFilter([zbw], facilityAndAircraft)).toBe(false);
		expect(matchesFilter([zbw, aal11], facilityAndAircraft)).toBe(true);
	});

	it("is asymmetric: two checked tags widen within a namespace, narrow across", () => {
		// The same item and the same checked count, differing only in whether the
		// second tag shares the first's namespace. Getting this backwards is the
		// failure that makes faceted search feel broken, so pin it directly.
		const item = [zbw];
		expect(matchesFilter(item, new Set(["facility:zny"]))).toBe(false);
		expect(
			matchesFilter(item, new Set(["facility:zbw", "facility:zny"])),
		).toBe(true);
		expect(
			matchesFilter(item, new Set(["facility:zbw", "aircraft:aal11"])),
		).toBe(false);
	});

	it("requires one hit per checked namespace across three namespaces", () => {
		const checked = new Set([
			"facility:zbw",
			"facility:zny",
			"aircraft:aal11",
			"topic:hijack",
		]);
		const topic = def("topic:hijack");
		expect(matchesFilter([zny, aal11, topic], checked)).toBe(true);
		expect(matchesFilter([zny, aal11], checked)).toBe(false);
		expect(matchesFilter([zny, topic], checked)).toBe(false);
	});

	it("excludes an item with no tags once any filter is active", () => {
		const checked = new Set(["facility:zbw"]);
		expect(matchesFilter([], checked)).toBe(false);
		expect(matchesFilter(undefined, checked)).toBe(false);
	});

	it("ignores an item tag outside every checked namespace", () => {
		expect(matchesFilter([zbw, aal11], new Set(["facility:zbw"]))).toBe(true);
	});

	it("treats a colonless checked tag as a facet of its own", () => {
		const checked = new Set(["facility:zbw", "orphan"]);
		expect(matchesFilter([zbw], checked)).toBe(false);
		expect(matchesFilter([zbw, { tag: "orphan" }], checked)).toBe(true);
	});

	describe("tier:unknown", () => {
		const clip = def("tier:clip");
		const tape = def("tier:tape");

		it("matches an item with no tags at all", () => {
			const checked = new Set([UNKNOWN_TIER_TAG]);
			expect(matchesFilter([], checked)).toBe(true);
			expect(matchesFilter(undefined, checked)).toBe(true);
		});

		it("matches an item whose tags carry no tier namespace", () => {
			const checked = new Set([UNKNOWN_TIER_TAG]);
			expect(matchesFilter([zbw, aal11], checked)).toBe(true);
		});

		it("does not match an item that already carries a real tier tag", () => {
			const checked = new Set([UNKNOWN_TIER_TAG]);
			expect(matchesFilter([tape], checked)).toBe(false);
			expect(matchesFilter([clip], checked)).toBe(false);
		});

		it("ORs with tier:clip, the pair RadioTrafficContext defaults to", () => {
			const checked = new Set(["tier:clip", UNKNOWN_TIER_TAG]);
			expect(matchesFilter([clip], checked)).toBe(true);
			expect(matchesFilter([], checked)).toBe(true);
			expect(matchesFilter([tape], checked)).toBe(false);
		});

		it("still ANDs against an unrelated namespace also checked", () => {
			const checked = new Set([UNKNOWN_TIER_TAG, "facility:zbw"]);
			// No tier tag (satisfies tier:unknown) but the wrong facility.
			expect(matchesFilter([zny], checked)).toBe(false);
			expect(matchesFilter([zbw], checked)).toBe(true);
		});
	});
});

describe("withUnknownTier", () => {
	it("appends an Unknown value to the tier group only", () => {
		const groups = withUnknownTier(
			groupVocabulary([def("tier:clip"), def("tier:tape"), def("topic:hijack")]),
		);
		const tier = groups.find((g) => g.namespace === "tier");
		const topic = groups.find((g) => g.namespace === "topic");
		expect(tier?.values.map((v) => v.tag)).toEqual(["tier:clip", "tier:tape", UNKNOWN_TIER_TAG]);
		expect(topic?.values.map((v) => v.tag)).toEqual(["topic:hijack"]);
	});

	it("leaves every other group's values untouched", () => {
		expect(withUnknownTier(groupVocabulary([def("topic:hijack")]))).toEqual(
			groupVocabulary([def("topic:hijack")]),
		);
	});

	it("does nothing to an empty vocabulary", () => {
		expect(withUnknownTier(groupVocabulary([]))).toEqual([]);
	});
});

describe("isTapeTier", () => {
	it("is true for an item carrying tier:tape", () => {
		expect(isTapeTier({ tags: [def("tier:tape")] })).toBe(true);
	});

	it("is false for an item carrying tier:clip", () => {
		expect(isTapeTier({ tags: [def("tier:clip")] })).toBe(false);
	});

	it("is false for an item with no tier tag at all", () => {
		expect(isTapeTier({ tags: [def("topic:hijack")] })).toBe(false);
	});

	it("is false for an item with no tags", () => {
		expect(isTapeTier({ tags: [] })).toBe(false);
	});

	it("is false for undefined meta", () => {
		expect(isTapeTier(undefined)).toBe(false);
	});
});
