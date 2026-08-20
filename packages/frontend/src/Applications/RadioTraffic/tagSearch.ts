/**
 * Searching one large namespace's vocabulary.
 *
 * `aircraft` has 377 values, `facility` 372, `person` 339 — the three the
 * sidebar hands to a picker instead of expanding inline (see tagFilter's
 * LARGE_NAMESPACES). Every one of those values is re-filtered on every
 * keystroke, so the lowercased haystack is built once, up front, and the
 * per-keystroke work is one `toLowerCase` on the query plus one `indexOf` per
 * value. Nothing here may touch the raw vocabulary again after the index is
 * built — `tagSearch.test.ts` counts the reads.
 */
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";

/** One vocabulary row beside the lowercased text a query is matched against. */
interface IndexEntry {
	tag: TagDef;
	lowered: string;
}

/** A namespace's vocabulary, prepared for repeated searching. Opaque by design. */
export interface SearchIndex {
	readonly entries: readonly IndexEntry[];
}

/**
 * Lowercase every value once, keeping the order the server sent.
 *
 * Rebuild only when the vocabulary itself changes — rebuilding per keystroke
 * would put the cost back exactly where the index exists to take it out of.
 */
export function buildSearchIndex(values: TagDef[]): SearchIndex {
	return {
		entries: values.map((tag) => ({
			tag,
			// `value` is optional on TagDef only because Go's omitempty drops an
			// empty string; such a row stays listable but matches no query.
			lowered: (tag.value ?? "").toLowerCase(),
		})),
	};
}

/**
 * The values matching `query`, case-insensitively, prefix matches first.
 *
 * Ranking prefixes above substrings is what makes typing a callsign find the
 * callsign: "ual" should reach UAL175 before the tail number N591UAL that
 * merely ends in it. Within each band the server's order is preserved — the
 * vocabulary arrives ordered by a `sort` column that is deliberately not on the
 * wire (see tagFilter's groupVocabulary), so re-sorting would discard a
 * curator's ordering with no way to reconstruct it.
 *
 * An empty query returns everything: a blank field means "no filter yet", not
 * "no such tag". The query is trimmed, because a pasted value carries padding
 * and no tag value contains a space.
 */
export function searchTags(index: SearchIndex, query: string): TagDef[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return index.entries.map((entry) => entry.tag);

	const prefix: TagDef[] = [];
	const substring: TagDef[] = [];
	for (const entry of index.entries) {
		const at = entry.lowered.indexOf(needle);
		if (at === 0) prefix.push(entry.tag);
		else if (at > 0) substring.push(entry.tag);
	}
	return prefix.concat(substring);
}
