import { describe, expect, it } from "vitest";
import { chipColor, tagLabel, tagsIn, TAG_NAMESPACES } from "./tagPalette";

describe("chipColor", () => {
	it("keys off the namespace, because mp3_tags.color is null on every row", () => {
		// Verified against the live cluster 2026-08-18: 0 of 1131 rows carry a
		// colour. If the palette needed `color`, every chip would render bare.
		const facility = chipColor({ tag: "facility:zbw", namespace: "facility" });
		const aircraft = chipColor({ tag: "aircraft:aal11", namespace: "aircraft" });
		expect(facility).toBeTruthy();
		expect(aircraft).toBeTruthy();
		expect(facility).not.toBe(aircraft);
	});

	it("gives every namespace the vocabulary uses its own colour", () => {
		const colours = TAG_NAMESPACES.map((namespace) =>
			chipColor({ tag: `${namespace}:x`, namespace }),
		);
		expect(new Set(colours).size).toBe(TAG_NAMESPACES.length);
	});

	it("honours a curator's colour when one is ever set", () => {
		expect(
			chipColor({ tag: "facility:zbw", namespace: "facility", color: "#123456" }),
		).toBe("#123456");
	});

	it("falls back to a neutral chip for a namespace it has no colour for", () => {
		// namespace is NOT NULL in the schema, so this is the "a curator added a
		// ninth namespace" case, not the "no namespace" case — either way the
		// chip must still paint rather than vanish into the panel background.
		const unknown = chipColor({ tag: "weather:vfr", namespace: "weather" });
		const missing = chipColor({ tag: "loose" });
		expect(unknown).toBeTruthy();
		expect(missing).toBe(unknown);
	});
});

describe("tagLabel", () => {
	it("shows the human value rather than the namespaced key", () => {
		expect(tagLabel({ tag: "facility:zbw", namespace: "facility", value: "ZBW" })).toBe(
			"ZBW",
		);
	});

	it("falls back to the tag when the vocabulary carries no value", () => {
		expect(tagLabel({ tag: "facility:zbw", namespace: "facility" })).toBe("facility:zbw");
	});

	it("treats a blank value as no value", () => {
		expect(tagLabel({ tag: "facility:zbw", value: "   " })).toBe("facility:zbw");
	});
});

describe("tagsIn", () => {
	const tags = [
		{ tag: "topic:hijacking", namespace: "topic", value: "Hijacking" },
		{ tag: "facility:zbw", namespace: "facility", value: "ZBW" },
		{ tag: "topic:handoff", namespace: "topic", value: "Handoff" },
	];

	it("selects one namespace, preserving vocabulary order", () => {
		expect(tagsIn(tags, "topic").map((t) => t.value)).toEqual(["Hijacking", "Handoff"]);
	});

	it("is empty for a namespace the item has no tags in", () => {
		expect(tagsIn(tags, "aircraft")).toEqual([]);
	});

	it("is empty for an item with no tags at all", () => {
		expect(tagsIn(undefined, "topic")).toEqual([]);
	});
});
