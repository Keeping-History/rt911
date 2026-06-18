import { describe, expect, it } from "vitest";
import type { NewsgroupSource } from "../../Providers/MediaStream/MediaStreamContext";
import {
	allFolderPaths,
	buildGroupTree,
	filterGroups,
	flatGroupRows,
	flattenGroupTree,
	sortGroupTree,
} from "./groupTree";

const src = (name: string, count = 0): NewsgroupSource => ({ name, count });

describe("buildGroupTree", () => {
	it("nests a dotted name into one node per path segment", () => {
		const tree = buildGroupTree([src("comp.lang.c", 5)]);
		expect(tree.map((n) => n.segment)).toEqual(["comp"]);
		const comp = tree[0];
		expect(comp.path).toBe("comp");
		expect(comp.isGroup).toBe(false);
		expect(comp.children.map((n) => n.segment)).toEqual(["lang"]);
		const lang = comp.children[0];
		expect(lang.path).toBe("comp.lang");
		const c = lang.children[0];
		expect(c.segment).toBe("c");
		expect(c.path).toBe("comp.lang.c");
		expect(c.isGroup).toBe(true);
		expect(c.ownCount).toBe(5);
	});

	it("merges siblings under a shared parent", () => {
		const tree = buildGroupTree([src("comp.lang.c"), src("comp.lang.python")]);
		const lang = tree[0].children[0];
		expect(lang.children.map((n) => n.segment)).toEqual(["c", "python"]);
	});

	it("marks a name that is both a real group and a namespace", () => {
		const tree = buildGroupTree([src("comp.lang", 42), src("comp.lang.c", 5)]);
		const lang = tree[0].children[0];
		expect(lang.isGroup).toBe(true);
		expect(lang.ownCount).toBe(42);
		expect(lang.children.map((n) => n.segment)).toEqual(["c"]);
	});

	it("aggregates totalCount over all descendant groups", () => {
		const tree = buildGroupTree([src("comp.lang", 42), src("comp.lang.c", 5), src("comp.os", 3)]);
		const comp = tree[0];
		expect(comp.totalCount).toBe(50); // 42 + 5 + 3
		const lang = comp.children.find((n) => n.segment === "lang")!;
		expect(lang.totalCount).toBe(47); // 42 + 5
	});

	it("leaves a leaf group's totalCount equal to its own count", () => {
		const tree = buildGroupTree([src("comp.lang.c", 5)]);
		const c = tree[0].children[0].children[0];
		expect(c.totalCount).toBe(5);
	});

	it("sorts roots and children alphabetically", () => {
		const tree = buildGroupTree([src("rec.arts"), src("alt.test"), src("comp.lang.python"), src("comp.lang.c")]);
		expect(tree.map((n) => n.segment)).toEqual(["alt", "comp", "rec"]);
		const lang = tree.find((n) => n.segment === "comp")!.children[0];
		expect(lang.children.map((n) => n.segment)).toEqual(["c", "python"]);
	});

	it("treats a single-segment name as a top-level group", () => {
		const tree = buildGroupTree([src("misc", 9)]);
		expect(tree).toHaveLength(1);
		expect(tree[0].isGroup).toBe(true);
		expect(tree[0].path).toBe("misc");
	});
});

describe("flattenGroupTree", () => {
	const tree = () => buildGroupTree([src("comp.lang.c", 5), src("rec.arts", 2)]);

	it("shows only roots when nothing is expanded", () => {
		const rows = flattenGroupTree(tree(), new Set());
		expect(rows.map((r) => r.node.path)).toEqual(["comp", "rec"]);
		expect(rows[0].depth).toBe(0);
		expect(rows[0].hasChildren).toBe(true);
		expect(rows[0].collapsed).toBe(true);
	});

	it("reveals a node's children only when its path is expanded", () => {
		const rows = flattenGroupTree(tree(), new Set(["comp"]));
		expect(rows.map((r) => r.node.path)).toEqual(["comp", "comp.lang", "rec"]);
		const comp = rows.find((r) => r.node.path === "comp")!;
		expect(comp.collapsed).toBe(false);
		const lang = rows.find((r) => r.node.path === "comp.lang")!;
		expect(lang.depth).toBe(1);
		expect(lang.collapsed).toBe(true);
	});

	it("descends through every expanded level to the leaf", () => {
		const rows = flattenGroupTree(tree(), new Set(["comp", "comp.lang"]));
		expect(rows.map((r) => r.node.path)).toEqual(["comp", "comp.lang", "comp.lang.c", "rec"]);
		const leaf = rows.find((r) => r.node.path === "comp.lang.c")!;
		expect(leaf.depth).toBe(2);
		expect(leaf.hasChildren).toBe(false);
	});
});

describe("filterGroups", () => {
	const groups = [src("comp.lang.c"), src("comp.lang.python"), src("rec.arts.movies")];

	it("returns every group when the query is blank", () => {
		expect(filterGroups(groups, "")).toEqual(groups);
		expect(filterGroups(groups, "   ")).toEqual(groups);
	});

	it("keeps groups whose full name contains the query, case-insensitively", () => {
		expect(filterGroups(groups, "LANG").map((g) => g.name)).toEqual([
			"comp.lang.c",
			"comp.lang.python",
		]);
	});

	it("matches on any part of the dotted path", () => {
		expect(filterGroups(groups, "movies").map((g) => g.name)).toEqual(["rec.arts.movies"]);
	});

	it("returns nothing when no group matches", () => {
		expect(filterGroups(groups, "zzz")).toEqual([]);
	});
});

describe("flatGroupRows", () => {
	it("renders one depth-0 leaf row per group, full name as label, sorted", () => {
		const rows = flatGroupRows([src("rec.arts", 2), src("comp.lang.c", 5)]);
		expect(rows.map((r) => r.node.path)).toEqual(["comp.lang.c", "rec.arts"]);
		const first = rows[0];
		expect(first.depth).toBe(0);
		expect(first.hasChildren).toBe(false);
		expect(first.collapsed).toBe(false);
		expect(first.node.segment).toBe("comp.lang.c"); // full name, not just last segment
		expect(first.node.isGroup).toBe(true);
		expect(first.node.ownCount).toBe(5);
	});

	it("returns an empty list for no groups", () => {
		expect(flatGroupRows([])).toEqual([]);
	});

	it("sorts by descending count when field is \"count\", tie-broken by name", () => {
		const rows = flatGroupRows(
			[src("alt.small", 2), src("comp.big", 99), src("rec.same", 2)],
			"count",
		);
		expect(rows.map((r) => r.node.path)).toEqual(["comp.big", "alt.small", "rec.same"]);
	});
});

describe("sortGroupTree", () => {
	it("leaves alphabetical order untouched when field is \"name\"", () => {
		const tree = buildGroupTree([src("comp.lang.python", 1), src("comp.lang.c", 9)]);
		const sorted = sortGroupTree(tree, "name");
		expect(sorted[0].children[0].children.map((n) => n.segment)).toEqual(["c", "python"]);
	});

	it("orders siblings at every depth by descending totalCount when field is \"count\"", () => {
		// comp.lang.python has more messages than comp.lang.c; rec outranks comp at root.
		const tree = buildGroupTree([
			src("comp.lang.c", 1),
			src("comp.lang.python", 50),
			src("rec.arts", 200),
		]);
		const sorted = sortGroupTree(tree, "count");
		expect(sorted.map((n) => n.segment)).toEqual(["rec", "comp"]);
		const lang = sorted.find((n) => n.segment === "comp")!.children[0];
		expect(lang.children.map((n) => n.segment)).toEqual(["python", "c"]);
	});

	it("does not mutate the input tree", () => {
		const tree = buildGroupTree([src("a.low", 1), src("a.high", 9)]);
		const before = tree[0].children.map((n) => n.segment);
		sortGroupTree(tree, "count");
		expect(tree[0].children.map((n) => n.segment)).toEqual(before);
	});
});

describe("allFolderPaths", () => {
	it("returns every node path that has children", () => {
		const tree = buildGroupTree([src("comp.lang.c"), src("rec.arts"), src("misc")]);
		expect(new Set(allFolderPaths(tree))).toEqual(new Set(["comp", "comp.lang", "rec"]));
	});
});
