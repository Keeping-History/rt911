import type { HyperCardPartProps } from "classicy";
import { ClassicyIcons, useAppManagerDispatch } from "classicy";
import { useCallback, useMemo } from "react";
import { handleNewsContentClick } from "../../../lib/newsContentLinks";
import { useNewsContentBalloon } from "../../../lib/useNewsContentBalloon";
import { newsFocusItem } from "../../News/NewsContext";
import { fetchDirectusNewsItem } from "./directusCollections";
import { resolveItemIds, useDirectusItem } from "./useDirectusItem";
import "./DirectusNewsPart.css";

/**
 * `directusNews` HyperCard part — embeds one or more articles from the
 * `news_items` Directus collection (History Commons news entries).
 *
 *   { "id": "story", "type": "directusNews", "rect": [16, 40, 388, 220],
 *     "options": { "itemId": [42], "showImage": true } }
 *
 * `itemId` is an array (issue #560's `NewsItemPicker` always writes one), but
 * a bare scalar/variable-name id is still accepted for a part authored before
 * that change, and each entry resolves through the stack expression engine
 * (so it may reference a variable/field). Two or more ids render as a
 * vertical list of articles; the article's `content` is first-party HTML
 * authored in Directus — rendered the same way the News app renders it.
 */

interface DirectusNewsOptions {
	itemIds: string[];
	showImage: boolean;
	showDate: boolean;
}

function readOptions(
	options: Record<string, unknown>,
	value: string,
	resolve: (expr: string) => string,
): DirectusNewsOptions {
	const o = options;
	return {
		itemIds: resolveItemIds(o.itemId, value, resolve),
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

/** One article's body — split out so `DirectusNewsPart` can render several, each with its own load state. */
function NewsArticle({
	itemId,
	showImage,
	showDate,
}: {
	itemId: string;
	showImage: boolean;
	showDate: boolean;
}) {
	const state = useDirectusItem(itemId, fetchDirectusNewsItem);
	const dispatch = useAppManagerDispatch();
	const { containerHandlers, balloon } = useNewsContentBalloon();
	const openNewsItem = useCallback(
		(docId: number) => {
			// Bring the News app forward (PlaylistProvider's applyFocus pattern)
			// before focusing — News may not already be running.
			dispatch({
				type: "ClassicyAppOpen",
				app: { id: "News.app", name: "News", icon: ClassicyIcons.applications.news.app as string },
			});
			dispatch(newsFocusItem(docId));
		},
		[dispatch],
	);

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
			{showDate && item.start_date && (
				<p className="classicyHyperCardNewsDate">{formatDate(item.start_date)}</p>
			)}
			{showImage && item.image && (
				<figure className="classicyHyperCardNewsFigure">
					<img src={item.image} alt={item.image_caption || item.title} />
					{item.image_caption && <figcaption>{item.image_caption}</figcaption>}
				</figure>
			)}
			{item.content && (
				<>
					{/* First-party HTML authored in Directus — rendered raw, exactly as
					the News app renders news_items.content. */}
					<div
						className="classicyHyperCardNewsBody"
						dangerouslySetInnerHTML={{ __html: item.content }}
						onClick={(e) => handleNewsContentClick(e, openNewsItem)}
						{...containerHandlers}
					/>
					{balloon}
				</>
			)}
		</article>
	);
}

/**
 * Zero resolved ids renders the same "No article selected" message as
 * before; one id renders exactly as before (a single `.classicyHyperCardNews`
 * article, no extra wrapper); two or more render as a scrollable list of
 * articles (issue #560).
 */
export const DirectusNewsPart = ({ options, value, resolve }: HyperCardPartProps) => {
	const opts = useMemo(() => readOptions(options, value, resolve), [options, value, resolve]);

	if (opts.itemIds.length === 0) {
		return <div className="classicyHyperCardNews classicyHyperCardNewsMessage">No article selected</div>;
	}
	if (opts.itemIds.length === 1) {
		return <NewsArticle itemId={opts.itemIds[0]} showImage={opts.showImage} showDate={opts.showDate} />;
	}
	return (
		<div className="classicyHyperCardNewsList">
			{opts.itemIds.map((id, i) => (
				<div className="classicyHyperCardNewsListItem" key={`${id}-${i}`}>
					<NewsArticle itemId={id} showImage={opts.showImage} showDate={opts.showDate} />
				</div>
			))}
		</div>
	);
};
