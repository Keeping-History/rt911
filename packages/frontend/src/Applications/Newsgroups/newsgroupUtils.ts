import type { UsenetItem } from "../../Providers/MediaStream/MediaStreamContext";

export interface ThreadNode {
	item: UsenetItem;
	/** Indentation depth in the conversation tree (0 = thread root). */
	depth: number;
}

/** A whole conversation: its root message plus every descendant, aggregated. */
export interface Thread {
	/** Stable identity for collapse state — root message_id, or "id:<n>" fallback. */
	key: string;
	root: UsenetItem;
	/** Root + descendants, depth-annotated, chronological within each level. */
	nodes: ThreadNode[];
	/** Total messages in the thread, including the root. */
	count: number;
	/** Epoch ms of the newest message anywhere in the thread (activity time). */
	latestDate: number;
	/** Epoch ms of the root message (thread start). */
	rootDate: number;
}

export type SortField = "subject" | "author" | "date";
export type SortDir = "asc" | "desc";
export interface SortSpec {
	field: SortField;
	dir: SortDir;
}

/** One rendered grid row — a collapsed thread root, or a message inside an expanded thread. */
export interface RenderRow {
	item: UsenetItem;
	depth: number;
	isRoot: boolean;
	threadKey: string;
	/** Thread message count (meaningful on root rows, where the badge shows). */
	count: number;
	hasChildren: boolean;
	collapsed: boolean;
	/** ISO date to display: a collapsed root shows the thread's latest activity;
	 * every other row shows the message's own date. */
	displayDate: string;
}

const epochOf = (item: UsenetItem) => new Date(item.start_date).getTime();
const byDate = (a: UsenetItem, b: UsenetItem) => epochOf(a) - epochOf(b);

const threadKey = (root: UsenetItem) => root.message_id ?? `id:${root.id}`;

interface ThreadIndex {
	childrenOf: Map<string, UsenetItem[]>;
	roots: UsenetItem[];
}

/**
 * Index a flat message set into parent→children links and a list of roots.
 * A message is a root when its parent is absent from the set (or it is its own
 * parent). Shared by both the flat-tree and thread-aggregate builders.
 */
function indexThreads(messages: UsenetItem[]): ThreadIndex {
	const byId = new Map<string, UsenetItem>();
	for (const m of messages) {
		if (m.message_id) byId.set(m.message_id, m);
	}

	const childrenOf = new Map<string, UsenetItem[]>();
	const roots: UsenetItem[] = [];
	for (const m of messages) {
		const parent = m.parent_id;
		if (parent && byId.has(parent) && parent !== m.message_id) {
			const arr = childrenOf.get(parent) ?? [];
			arr.push(m);
			childrenOf.set(parent, arr);
		} else {
			roots.push(m);
		}
	}
	return { childrenOf, roots };
}

/**
 * Walk one thread from its root, producing depth-annotated nodes in chronological
 * order and aggregating count + newest-activity time. The shared `seen` set guards
 * against cycles and stops a message being claimed by two roots.
 */
function walkThread(
	root: UsenetItem,
	childrenOf: Map<string, UsenetItem[]>,
	seen: Set<number>,
): Thread {
	const nodes: ThreadNode[] = [];
	let latestDate = epochOf(root);
	const visit = (item: UsenetItem, depth: number) => {
		if (seen.has(item.id)) return;
		seen.add(item.id);
		nodes.push({ item, depth });
		latestDate = Math.max(latestDate, epochOf(item));
		const kids = (item.message_id ? childrenOf.get(item.message_id) : undefined) ?? [];
		kids.sort(byDate);
		for (const k of kids) visit(k, depth + 1);
	};
	visit(root, 0);
	return { key: threadKey(root), root, nodes, count: nodes.length, latestDate, rootDate: epochOf(root) };
}

/**
 * Aggregate a flat list of messages into whole threads. Every message lands in
 * exactly one thread; a message stranded by a reference cycle becomes its own
 * single-message thread so nothing is ever silently dropped.
 */
export function buildThreads(messages: UsenetItem[]): Thread[] {
	const { childrenOf, roots } = indexThreads(messages);
	const seen = new Set<number>();
	const threads: Thread[] = [];
	for (const r of roots) {
		threads.push(walkThread(r, childrenOf, seen));
	}
	for (const m of messages) {
		if (!seen.has(m.id)) {
			seen.add(m.id);
			threads.push({
				key: threadKey(m),
				root: m,
				nodes: [{ item: m, depth: 0 }],
				count: 1,
				latestDate: epochOf(m),
				rootDate: epochOf(m),
			});
		}
	}
	return threads;
}

/**
 * Order top-level threads by a column. Replies inside each thread are never
 * reordered — only the threads themselves move — so the conversation structure
 * survives any sort. `date` sorts on latest activity (the default view's intent).
 */
export function sortThreads(threads: Thread[], sort: SortSpec): Thread[] {
	const dir = sort.dir === "asc" ? 1 : -1;
	const keyOf = (t: Thread): string | number => {
		switch (sort.field) {
			case "date":
				return t.latestDate;
			case "subject":
				return (t.root.subject ?? "").trim().toLowerCase();
			case "author":
				return (t.root.author ?? "").trim().toLowerCase();
		}
	};
	return [...threads].sort((a, b) => {
		const ka = keyOf(a);
		const kb = keyOf(b);
		if (ka < kb) return -dir;
		if (ka > kb) return dir;
		return 0;
	});
}

/**
 * Flatten sorted threads into render rows honoring the expanded set. A collapsed
 * thread contributes only its root row (with count badge + latest-activity date);
 * an expanded thread contributes every message, each showing its own date.
 */
export function flattenThreads(threads: Thread[], expanded: Set<string>): RenderRow[] {
	const rows: RenderRow[] = [];
	for (const t of threads) {
		const hasChildren = t.count > 1;
		if (!expanded.has(t.key)) {
			rows.push({
				item: t.root,
				depth: 0,
				isRoot: true,
				threadKey: t.key,
				count: t.count,
				hasChildren,
				collapsed: true,
				displayDate: new Date(t.latestDate).toISOString(),
			});
		} else {
			for (const n of t.nodes) {
				rows.push({
					item: n.item,
					depth: n.depth,
					isRoot: n.depth === 0,
					threadKey: t.key,
					count: t.count,
					hasChildren,
					collapsed: false,
					displayDate: n.item.start_date,
				});
			}
		}
	}
	return rows;
}

