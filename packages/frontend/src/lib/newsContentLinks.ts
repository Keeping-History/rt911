/**
 * Link handling for rendered `news_items.content` HTML — shared by the News
 * app's detail view and HyperCard's `directusNews` part, which both render
 * the same Directus-authored article body via `dangerouslySetInnerHTML`.
 *
 * Cross-references to another `news_items` row are migrated (see
 * packages/backend/migrate-news-item-links.mjs) to a hash-fragment href in
 * this form, so a click can be resolved without a network round trip and a
 * stray click before the handler attaches, or a middle-click into a new tab,
 * just changes the fragment instead of erroring or navigating away.
 */
export const NEWS_ITEM_HASH_PREFIX = "#/news-item/";

/** Extracts the target news_items id from an internal cross-reference href, or null if href isn't one. */
export function parseNewsItemHref(href: string | null | undefined): number | null {
	if (!href || !href.startsWith(NEWS_ITEM_HASH_PREFIX)) return null;
	const id = Number(href.slice(NEWS_ITEM_HASH_PREFIX.length));
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Reads the balloon-help title baked into an anchor by the news-links
 * migration (see packages/backend/migrate-news-item-balloons.mjs), which
 * strips the article's original (dead — historycommons.org's `OL()`/`nd()`
 * tooltip functions don't exist here) `onmouseover`/`onmouseout` and stashes
 * the tooltip text as `data-balloon-title` instead: the target news item's
 * own title for an internal cross-reference, or the original citation text
 * for an external source link.
 */
export function parseBalloonTitle(anchor: HTMLAnchorElement): string | null {
	const title = anchor.getAttribute("data-balloon-title")?.trim();
	return title ? title : null;
}

interface DelegatedClickEvent {
	target: EventTarget | null;
	preventDefault: () => void;
}

/**
 * Click handler for a container `dangerouslySetInnerHTML`'d with article
 * body HTML. Attach to the container (event delegation — the HTML is opaque
 * to React, so there's nothing to attach a handler to per-anchor).
 *
 * An internal cross-reference (`#/news-item/<id>`) opens in-app via
 * `onOpenNewsItem`; every other link is treated as external and opened in a
 * new browser window/tab, never navigating the SPA away in place.
 */
export function handleNewsContentClick(
	event: DelegatedClickEvent,
	onOpenNewsItem: (id: number) => void,
): void {
	const target = event.target as HTMLElement | null;
	const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
	if (!anchor) return;

	const href = anchor.getAttribute("href");
	const internalId = parseNewsItemHref(href);
	if (internalId !== null) {
		event.preventDefault();
		onOpenNewsItem(internalId);
		return;
	}

	if (href && /^https?:\/\//i.test(href)) {
		event.preventDefault();
		window.open(href, "_blank", "noopener,noreferrer");
	}
}
