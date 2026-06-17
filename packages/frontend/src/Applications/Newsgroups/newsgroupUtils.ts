import type { UsenetItem } from "../../Providers/MediaStream/MediaStreamContext";

export interface ThreadNode {
	item: UsenetItem;
	/** Indentation depth in the conversation tree (0 = thread root). */
	depth: number;
}

const byDate = (a: UsenetItem, b: UsenetItem) =>
	new Date(a.start_date).getTime() - new Date(b.start_date).getTime();

/**
 * Order a flat list of messages into a threaded, depth-annotated list ready for
 * indented rendering. Roots (messages whose parent is absent from the set) are
 * ordered chronologically; each message's replies follow it, indented one level,
 * also chronological. Cycles and orphans are handled defensively so a malformed
 * thread can never drop a message or loop forever.
 */
export function buildThreadTree(messages: UsenetItem[]): ThreadNode[] {
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
			// No parent in this set (or self-parent) → a thread root.
			roots.push(m);
		}
	}
	roots.sort(byDate);

	const out: ThreadNode[] = [];
	const seen = new Set<number>();
	const visit = (item: UsenetItem, depth: number) => {
		if (seen.has(item.id)) return; // cycle guard
		seen.add(item.id);
		out.push({ item, depth });
		const kids = (item.message_id ? childrenOf.get(item.message_id) : undefined) ?? [];
		kids.sort(byDate);
		for (const k of kids) visit(k, depth + 1);
	};
	for (const r of roots) visit(r, 0);

	// Any message not reached (e.g. stranded by a cycle) is appended flat so the
	// view never silently drops a message.
	for (const m of messages) {
		if (!seen.has(m.id)) out.push({ item: m, depth: 0 });
	}
	return out;
}

/** A short, human label for a message row: subject + author, with sane fallbacks. */
export function messageLabel(item: UsenetItem): string {
	const subject = item.subject?.trim() || "(no subject)";
	const author = item.author?.trim();
	return author ? `${subject} — ${author}` : subject;
}
