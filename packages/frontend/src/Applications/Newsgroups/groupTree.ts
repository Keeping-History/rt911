import type { NewsgroupSource } from "../../Providers/MediaStream/MediaStreamContext";

/**
 * Filter newsgroups to those whose full dotted name contains the query
 * (case-insensitive substring). A blank/whitespace query returns the list
 * unchanged, so the caller can pass the raw search box value straight through.
 */
export function filterGroups(groups: NewsgroupSource[], query: string): NewsgroupSource[] {
	const q = query.trim().toLowerCase();
	if (!q) return groups;
	return groups.filter((g) => g.name.toLowerCase().includes(q));
}

/** One node in the dot-notation newsgroup tree (e.g. comp → comp.lang → comp.lang.c). */
export interface GroupTreeNode {
	/** Last path segment — the display label (e.g. "lang"). */
	segment: string;
	/** Full dotted path — stable key and the id used to select/read the group. */
	path: string;
	/** True when a real newsgroup exists at exactly this path (vs. a pure namespace). */
	isGroup: boolean;
	/** This group's own message count (0 when it is only a namespace). */
	ownCount: number;
	/** Sum of every descendant group's count, including this node's own. */
	totalCount: number;
	children: GroupTreeNode[];
}

/** A flattened, depth-annotated tree row ready for indented rendering. */
export interface GroupRow {
	node: GroupTreeNode;
	depth: number;
	hasChildren: boolean;
	collapsed: boolean;
}

const bySegment = (a: GroupTreeNode, b: GroupTreeNode) => a.segment.localeCompare(b.segment);

/**
 * Build a dot-notation tree from a flat list of newsgroups. Every path segment
 * becomes a node; a node is a real group only when a source names it exactly, so
 * a namespace like "comp.lang" can be both a readable group and a parent of
 * "comp.lang.c". Counts aggregate up: totalCount sums all descendant groups.
 */
export function buildGroupTree(groups: NewsgroupSource[]): GroupTreeNode[] {
	const roots: GroupTreeNode[] = [];
	const byPath = new Map<string, GroupTreeNode>();

	const ensure = (segment: string, path: string, siblings: GroupTreeNode[]): GroupTreeNode => {
		let node = byPath.get(path);
		if (!node) {
			node = { segment, path, isGroup: false, ownCount: 0, totalCount: 0, children: [] };
			byPath.set(path, node);
			siblings.push(node);
		}
		return node;
	};

	for (const g of groups) {
		const segments = g.name.split(".");
		let siblings = roots;
		let path = "";
		let node: GroupTreeNode | null = null;
		for (const segment of segments) {
			path = path ? `${path}.${segment}` : segment;
			node = ensure(segment, path, siblings);
			siblings = node.children;
		}
		if (node) {
			node.isGroup = true;
			node.ownCount = g.count;
		}
	}

	// Aggregate totals bottom-up and sort each level alphabetically.
	const finalize = (node: GroupTreeNode): number => {
		node.children.sort(bySegment);
		let total = node.ownCount;
		for (const child of node.children) total += finalize(child);
		node.totalCount = total;
		return total;
	};
	roots.sort(bySegment);
	for (const r of roots) finalize(r);

	return roots;
}

/**
 * Flatten the tree into depth-annotated rows, revealing a node's children only
 * when its path is in `expanded`. Roots are always emitted, so an empty set
 * renders the tree collapsed to its top level.
 */
export function flattenGroupTree(nodes: GroupTreeNode[], expanded: Set<string>): GroupRow[] {
	const rows: GroupRow[] = [];
	const visit = (node: GroupTreeNode, depth: number) => {
		const hasChildren = node.children.length > 0;
		const isExpanded = hasChildren && expanded.has(node.path);
		rows.push({ node, depth, hasChildren, collapsed: hasChildren && !isExpanded });
		if (isExpanded) {
			for (const child of node.children) visit(child, depth + 1);
		}
	};
	for (const n of nodes) visit(n, 0);
	return rows;
}

/**
 * Render newsgroups as a flat list of leaf rows (full name as the label, no
 * nesting) — the view used while a search filter is active, where hierarchy
 * would only get in the way. Sorted alphabetically by full name.
 */
export function flatGroupRows(groups: NewsgroupSource[]): GroupRow[] {
	return [...groups]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((g) => ({
			node: {
				segment: g.name,
				path: g.name,
				isGroup: true,
				ownCount: g.count,
				totalCount: g.count,
				children: [],
			},
			depth: 0,
			hasChildren: false,
			collapsed: false,
		}));
}

/** Every node path that has children — the set to expand for "Expand All". */
export function allFolderPaths(nodes: GroupTreeNode[]): string[] {
	const paths: string[] = [];
	const visit = (node: GroupTreeNode) => {
		if (node.children.length > 0) {
			paths.push(node.path);
			for (const child of node.children) visit(child);
		}
	};
	for (const n of nodes) visit(n);
	return paths;
}
