import type { HyperCardPartProps } from "classicy";
import { useMemo } from "react";
import { fetchDirectusNewsItem } from "./directusCollections";
import { resolveItemId, useDirectusItem } from "./useDirectusItem";
import "./DirectusNewsPart.css";

/**
 * `directusNews` HyperCard part — embeds one article from the `news_items`
 * Directus collection (History Commons news entries).
 *
 *   { "id": "story", "type": "directusNews", "rect": [16, 40, 388, 220],
 *     "options": { "itemId": 42, "showImage": true } }
 *
 * `itemId` resolves through the stack expression engine (so it may reference a
 * variable/field). The article's `content` is first-party HTML authored in
 * Directus — rendered the same way the News app renders it.
 */

interface DirectusNewsOptions {
	itemId?: string | number;
	showImage: boolean;
	showDate: boolean;
}

function readOptions(options: Record<string, unknown>): DirectusNewsOptions {
	const o = options;
	return {
		itemId:
			typeof o.itemId === "string" || typeof o.itemId === "number" ? o.itemId : undefined,
		showImage: o.showImage !== false,
		showDate: o.showDate !== false,
	};
}

/** Format an ISO/naive-UTC date as a readable dateline; passthrough on junk. */
function formatDate(iso: string | null | undefined): string {
	if (!iso) return "";
	const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(iso.trim());
	const d = new Date(hasZone ? iso : `${iso}Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString("en-US", {
		timeZone: "UTC",
		month: "long",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export const DirectusNewsPart = ({ options, value, resolve }: HyperCardPartProps) => {
	const opts = useMemo(() => readOptions(options), [options]);
	const id = resolveItemId(opts.itemId, value, resolve);
	const state = useDirectusItem(id, fetchDirectusNewsItem);

	if (state.status === "error") {
		return (
			<div className="classicyHyperCardNews classicyHyperCardNewsMessage" role="alert">
				Could not load article — {state.message}
			</div>
		);
	}
	if (state.status === "loading") {
		return <div className="classicyHyperCardNews classicyHyperCardNewsMessage">Loading article…</div>;
	}
	if (state.status !== "ready") {
		return <div className="classicyHyperCardNews classicyHyperCardNewsMessage">No article selected</div>;
	}

	const { item } = state;
	return (
		<article className="classicyHyperCardNews">
			<h1 className="classicyHyperCardNewsHeadline">{item.full_title || item.title}</h1>
			{opts.showDate && item.start_date && (
				<p className="classicyHyperCardNewsDate">{formatDate(item.start_date)}</p>
			)}
			{opts.showImage && item.image && (
				<figure className="classicyHyperCardNewsFigure">
					<img src={item.image} alt={item.image_caption || item.title} />
					{item.image_caption && <figcaption>{item.image_caption}</figcaption>}
				</figure>
			)}
			{item.content && (
				// First-party HTML authored in Directus — rendered raw, exactly as
				// the News app renders news_items.content.
				<div
					className="classicyHyperCardNewsBody"
					dangerouslySetInnerHTML={{ __html: item.content }}
				/>
			)}
		</article>
	);
};
