import { describe, expect, it } from "vitest";
import { buildPageTree, type PageSummary } from "./pageTree";

function page(over: Partial<PageSummary> & { id: number }): PageSummary {
	return {
		title: `Page ${over.id}`,
		slug: `page-${over.id}`,
		parent: null,
		sort: null,
		...over,
	};
}

/** Every input id must appear exactly once somewhere in the forest. */
function collectIds(nodes: ReturnType<typeof buildPageTree>): number[] {
	return nodes.flatMap((n) => [n.id, ...collectIds(n.children)]);
}

describe("buildPageTree", () => {
	it("nests children under their parent", () => {
		const tree = buildPageTree([
			page({ id: 1, title: "About" }),
			page({ id: 2, title: "Credits", parent: 1 }),
		]);
		expect(tree).toHaveLength(1);
		expect(tree[0].id).toBe(1);
		expect(tree[0].children.map((c) => c.id)).toEqual([2]);
	});

	it("orders siblings by sort ascending, unsorted last, ties by title", () => {
		const tree = buildPageTree([
			page({ id: 1, title: "Zulu", sort: 2 }),
			page({ id: 2, title: "Alpha", sort: 1 }),
			page({ id: 3, title: "Bravo", sort: null }),
			page({ id: 4, title: "Aardvark", sort: null }),
		]);
		expect(tree.map((n) => n.title)).toEqual(["Alpha", "Zulu", "Aardvark", "Bravo"]);
	});

	it("sorts nested levels too, not just roots", () => {
		const tree = buildPageTree([
			page({ id: 1 }),
			page({ id: 2, title: "Second", parent: 1, sort: 2 }),
			page({ id: 3, title: "First", parent: 1, sort: 1 }),
		]);
		expect(tree[0].children.map((c) => c.title)).toEqual(["First", "Second"]);
	});

	// A draft or deleted parent is absent from the published set. Its children
	// must still surface rather than silently disappearing from the menu.
	it("promotes a page whose parent is not in the set", () => {
		const tree = buildPageTree([page({ id: 2, parent: 99 })]);
		expect(tree.map((n) => n.id)).toEqual([2]);
	});

	// Nothing in Directus prevents an author making this; an unguarded builder
	// would recurse forever.
	it("terminates on a two-page cycle and keeps both pages", () => {
		const tree = buildPageTree([
			page({ id: 1, parent: 2 }),
			page({ id: 2, parent: 1 }),
		]);
		expect(collectIds(tree).sort()).toEqual([1, 2]);
	});

	it("terminates on a longer cycle and keeps every page", () => {
		const tree = buildPageTree([
			page({ id: 1, parent: 3 }),
			page({ id: 2, parent: 1 }),
			page({ id: 3, parent: 2 }),
		]);
		expect(collectIds(tree).sort()).toEqual([1, 2, 3]);
	});

	it("terminates on a page that is its own parent", () => {
		const tree = buildPageTree([page({ id: 1, parent: 1 })]);
		expect(collectIds(tree)).toEqual([1]);
	});

	// A cycle deeper in the chain must not strand the pages hanging off it.
	it("keeps every page exactly once when a cycle sits above real children", () => {
		const tree = buildPageTree([
			page({ id: 1, parent: 2 }),
			page({ id: 2, parent: 1 }),
			page({ id: 3, parent: 1 }),
			page({ id: 4 }),
		]);
		expect(collectIds(tree).sort()).toEqual([1, 2, 3, 4]);
	});

	it("returns an empty forest for no pages", () => {
		expect(buildPageTree([])).toEqual([]);
	});
});
