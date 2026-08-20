/**
 * Nav-tree construction for CMS pages.
 *
 * `pages.parent` is a self-referential M2O that groups the menu; it has no
 * bearing on a page's URL, which is always the flat `/<slug>`.
 */

export interface PageSummary {
	id: number;
	title: string;
	slug: string;
	parent: number | null;
	sort: number | null;
}

export interface PageNode extends PageSummary {
	children: PageNode[];
}

/** Smallest `sort` first, unsorted pages last, ties broken by title. */
function bySortThenTitle(a: PageSummary, b: PageSummary): number {
	if (a.sort !== b.sort) {
		if (a.sort == null) return 1;
		if (b.sort == null) return -1;
		return a.sort - b.sort;
	}
	return a.title.localeCompare(b.title);
}

/**
 * Resolve the parent a page should actually hang from.
 *
 * Returns null — making the page a root — when the parent is missing from the
 * set (unpublished or deleted, so its children would otherwise vanish), or when
 * following the chain upwards revisits a page.
 *
 * The cycle guard is not hypothetical: nothing in Directus stops an author from
 * pointing A at B and B back at A through the parent picker, and an unguarded
 * builder would loop forever and hang the tab.
 */
function effectiveParent(page: PageSummary, byId: Map<number, PageSummary>): number | null {
	if (page.parent == null) return null;
	if (!byId.has(page.parent)) return null;

	const seen = new Set<number>([page.id]);
	let cursor: number | null = page.parent;
	while (cursor != null) {
		if (seen.has(cursor)) return null; // cycle — treat this page as a root
		seen.add(cursor);
		cursor = byId.get(cursor)?.parent ?? null;
	}
	return page.parent;
}

/**
 * Build the menu forest. Pure and total: every input page appears exactly once
 * in the output, either nested under its parent or promoted to a root.
 */
export function buildPageTree(pages: PageSummary[]): PageNode[] {
	const byId = new Map(pages.map((p) => [p.id, p]));
	const nodes = new Map<number, PageNode>(pages.map((p) => [p.id, { ...p, children: [] }]));
	const roots: PageNode[] = [];

	for (const page of pages) {
		const node = nodes.get(page.id)!;
		const parentId = effectiveParent(page, byId);
		if (parentId == null) roots.push(node);
		else nodes.get(parentId)!.children.push(node);
	}

	const sortRecursive = (list: PageNode[]) => {
		list.sort(bySortThenTitle);
		for (const n of list) sortRecursive(n.children);
	};
	sortRecursive(roots);

	return roots;
}
