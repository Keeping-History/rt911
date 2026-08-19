// How a tag paints on a card.
//
// mp3_tags carries `color` and `sort` columns a curator may set, but 0 of the
// 1131 rows have a colour today (verified against the live cluster 2026-08-18).
// So the namespace is the palette's only real source: keying off `color` would
// render every chip in the corpus identically. `color` is still honoured when
// it is ever set, which is what makes the curator column worth having.

import type { TagDef } from "../../../Providers/MediaStream/MediaStreamContext";

/**
 * The eight namespaces tags.py emits, which are also the filter tree's groups.
 * `mp3_tags.namespace` is NOT NULL, so there is no un-namespaced bucket — a
 * ninth name here would mean a curator added a namespace, not that a tag lost
 * one, and it falls through to the neutral chip rather than vanishing.
 */
export const TAG_NAMESPACES = [
	"topic",
	"facility",
	"link",
	"tier",
	"aircraft",
	"agency",
	"role",
	"person",
] as const;

/** Chip fill per namespace. The values live in cardTabs.module.scss. */
export const NS_COLOR: Record<string, string | undefined> = {
	topic: "var(--rt-tag-topic)",
	facility: "var(--rt-tag-facility)",
	link: "var(--rt-tag-link)",
	tier: "var(--rt-tag-tier)",
	aircraft: "var(--rt-tag-aircraft)",
	agency: "var(--rt-tag-agency)",
	role: "var(--rt-tag-role)",
	person: "var(--rt-tag-person)",
};

/** Fill for a namespace the palette has no colour for. */
export const DEFAULT_TAG_COLOR = "var(--rt-tag-default)";

/**
 * The row label a namespace's chips sit against in the Details panel's Tags
 * column. Plural, because the row holds a set — and written here beside the
 * colours rather than in the panel so the two halves of a namespace's
 * presentation cannot drift apart.
 *
 * The filter sidebar does NOT read this: its labels come down the wire with the
 * vocabulary, which is the curator's own naming. This table exists only for the
 * card, which never receives that frame.
 */
export const NS_LABEL: Record<string, string | undefined> = {
	topic: "Topics",
	facility: "Facilities",
	link: "Links",
	tier: "Tier",
	aircraft: "Aircraft",
	agency: "Agencies",
	role: "Roles",
	person: "People",
};

/** A namespace's row label, falling back to the namespace itself. */
export function namespaceLabel(namespace: string): string {
	return NS_LABEL[namespace] ?? namespace;
}

/** The chip's fill: a curator's colour if there is one, else the namespace. */
export function chipColor(tag: TagDef): string {
	if (tag.color) return tag.color;
	return (tag.namespace ? NS_COLOR[tag.namespace] : undefined) ?? DEFAULT_TAG_COLOR;
}

/** The chip's text: the vocabulary's human value, falling back to the key. */
export function tagLabel(tag: TagDef): string {
	return tag.value?.trim() || tag.tag;
}

/**
 * One namespace's tags, in the order the vocabulary gave them (the backend
 * already orders by `sort NULLS LAST, tag`, so this must not re-sort).
 */
export function tagsIn(
	tags: readonly TagDef[] | undefined,
	namespace: string,
): TagDef[] {
	return (tags ?? []).filter((tag) => tag.namespace === namespace);
}
