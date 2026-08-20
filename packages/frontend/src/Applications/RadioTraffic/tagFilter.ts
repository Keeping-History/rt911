/**
 * The filter sidebar's two pure operations: turning the flat tag vocabulary
 * into the tree the sidebar renders, and deciding whether one item survives the
 * checked set.
 *
 * Both are hot. The vocabulary is 1131 rows across 8 namespaces and is regrouped
 * whenever it is refetched; `matchesFilter` runs once per item per render across
 * the whole ~755-item back catalogue. Neither may scan its input more than once.
 */
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";

/** One namespace's worth of vocabulary, as the sidebar renders it. */
export interface TagGroup {
	namespace: string;
	label: string;
	values: TagDef[];
	large: boolean;
}

/**
 * aircraft 377, facility 372, person 339 — these open a picker instead of
 * expanding inline. The next largest namespace, `topic`, has 25 values, so the
 * gap the threshold sits in is an order of magnitude wide and naming the three
 * is clearer than a magic count that no data is near.
 */
export const LARGE_NAMESPACES = new Set(["aircraft", "facility", "person"]);

/** "aircraft" → "Aircraft". Every namespace is one lowercase word. */
function labelFor(namespace: string): string {
	return namespace.charAt(0).toUpperCase() + namespace.slice(1);
}

/**
 * Group the vocabulary by namespace, preserving the order it arrived in.
 *
 * The server sends `ORDER BY sort NULLS LAST, tag` and deliberately does **not**
 * ship the `sort` column (see backend `model.Tag`) — ordering the vocabulary is
 * the only thing it is for, so the client is given the result rather than the
 * input. Re-sorting here would therefore discard a curator's ordering with no
 * way to reconstruct it: preserving the incoming order *is* honouring `sort`,
 * with `tag` (a namespace and its value) as the tiebreak. `sort` is unset on
 * every row today, so that tiebreak is what orders the tree in practice.
 *
 * One pass, bucketing into a Map. Filtering the vocabulary once per namespace
 * would read all 1131 rows 8 times over for the same answer.
 *
 * `mp3_tags.namespace` is NOT NULL, so a row without one cannot occur — the
 * field is optional on TagDef only because Go's `omitempty` drops an empty
 * string. Such a row is skipped rather than collected into an "Other" bucket,
 * because there is no un-namespaced group in the sidebar for it to render in.
 */
export function groupVocabulary(vocab: TagDef[]): TagGroup[] {
	const byNamespace = new Map<string, TagGroup>();
	for (const tag of vocab) {
		const namespace = tag.namespace;
		if (!namespace) continue;
		let group = byNamespace.get(namespace);
		if (!group) {
			group = {
				namespace,
				label: labelFor(namespace),
				values: [],
				large: LARGE_NAMESPACES.has(namespace),
			};
			byNamespace.set(namespace, group);
		}
		group.values.push(tag);
	}
	return [...byNamespace.values()];
}

/** The namespace a vocabulary tag string belongs to; the whole tag if unprefixed. */
function namespaceOf(tag: string): string {
	const i = tag.indexOf(":");
	return i === -1 ? tag : tag.slice(0, i);
}

/**
 * Does `tags` survive `checked`? OR within a namespace, AND across namespaces.
 *
 * Checking a second facility widens the result; adding an aircraft narrows it.
 * That asymmetry is what makes a faceted sidebar behave the way a person reading
 * it expects — each namespace is an independent question, and the boxes ticked
 * inside one are alternative answers to it.
 *
 * An empty checked set matches everything, so the unfiltered app costs one Set
 * size check per item. Once any box is ticked an item with no tags is excluded:
 * it cannot answer the question that was asked.
 */
export function matchesFilter(
	tags: TagDef[] | undefined,
	checked: ReadonlySet<string>,
): boolean {
	if (checked.size === 0) return true;
	if (!tags || tags.length === 0) return false;

	const own = new Set(tags.map((t) => t.tag));
	// One hit anywhere in a namespace satisfies it (OR); every checked namespace
	// must be satisfied (AND).
	const satisfied = new Map<string, boolean>();
	for (const tag of checked) {
		const namespace = namespaceOf(tag);
		satisfied.set(namespace, (satisfied.get(namespace) ?? false) || own.has(tag));
	}
	for (const hit of satisfied.values()) {
		if (!hit) return false;
	}
	return true;
}
