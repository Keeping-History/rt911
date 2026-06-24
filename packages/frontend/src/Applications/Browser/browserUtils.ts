/**
 * Strip a TimeMachine/archive proxy wrapper from a URL, returning the original
 * target so the address bar and history hold clean URLs (not proxy URLs).
 *
 * Handles the proxy URL shapes the proxy emits when it rewrites page links:
 *   - <proxyHost>/…?url=<encoded original>&time=…   (query-param form)
 *   - <proxyHost>/web/<timestamp>/<original>         (archive.org style)
 *   - <proxyHost>/web/<original>                     (TimeMachine style)
 *
 * Returns the input unchanged if it is not a proxy URL for proxyHost.
 */
export const stripProxyUrl = (url: string, proxyHost: string): string => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	if (parsed.hostname !== proxyHost) return url;

	// Query-param form: …?url=<encoded original>
	const queryUrl = parsed.searchParams.get("url");
	if (queryUrl) return queryUrl;

	// Path form: /web/<original> or /web/<timestamp>/<original>. Match the full
	// string so the embedded scheme's "://" survives URL pathname parsing.
	const match = url.match(/\/web\/(?:\d+\*?\/)?(https?:\/\/.+)$/i);
	if (match) return match[1];

	return url;
};

export const normalizeUrl = (u: string): string => {
	try {
		const parsed = new URL(u);
		if (parsed.hostname.startsWith("www.")) {
			parsed.hostname = parsed.hostname.slice(4);
		}
		return parsed.toString().replace(/\/+$/, "");
	} catch {
		return u.replace(/\/+$/, "");
	}
};

/** True for absolute http(s) URLs — the only schemes the proxy can fetch. */
export const isNavigableUrl = (href: string): boolean => {
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
};

/**
 * If `href` is a proxy/archive URL, return the original target it wraps,
 * otherwise null. Mirrors the shapes stripProxyUrl handles.
 */
export const extractOriginalUrl = (
	href: string,
	proxyHost: string,
): string | null => {
	// Query-param form — match on hostname (default ports are dropped by the URL
	// parser, making port comparison unreliable).
	try {
		const parsed = new URL(href);
		if (parsed.hostname === proxyHost && parsed.searchParams.has("url")) {
			return parsed.searchParams.get("url");
		}
	} catch {
		/* not a valid URL, fall through */
	}

	// Path form: /web/<original> or /web/<timestamp>/<original>.
	const match = href.match(/\/web\/(?:\d+\*?\/)?(https?:\/\/.+)$/i);
	return match ? match[1] : null;
};

/**
 * Resolve a clicked link to the original http(s) URL the in-app browser should
 * navigate to, or null if it isn't navigable. Shared by click navigation and
 * visited-link matching so both interpret a link identically:
 *   1. de-proxy an archive/proxy URL,
 *   2. else resolve a relative href against the current page,
 *   3. else fall back to the resolved absolute href.
 */
export const resolveLinkTarget = (
	href: string,
	rawHref: string,
	currentUrl: string,
	proxyHost: string,
): string | null => {
	const original = extractOriginalUrl(href, proxyHost);
	if (original && isNavigableUrl(original)) return original;

	try {
		const resolved = new URL(rawHref, currentUrl).href;
		if (isNavigableUrl(resolved)) return resolved;
	} catch {
		/* invalid URL, fall through */
	}

	if (isNavigableUrl(href)) return href;
	return null;
};

/** Classic Netscape/IE default visited-link color, used when a page sets none. */
export const DEFAULT_VISITED_COLOR = "#551A8B";

/** Accept #rgb / #rrggbb hex and simple named colors; reject anything we can't
 * confidently treat as a CSS color (avoids injecting junk into inline styles). */
export const isValidCssColor = (color: string): boolean => {
	if (!color) return false;
	if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) return true;
	if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
		try {
			return CSS.supports("color", color);
		} catch {
			return false;
		}
	}
	// jsdom / no CSS.supports: allow bare color keywords (e.g. "purple").
	return /^[a-z]+$/i.test(color);
};

export interface BodyLinkColors {
	/** Unvisited link color (<body link=…>). */
	link: string | null;
	/** Visited link color (<body vlink=…>). */
	visited: string | null;
	/** Active (being-clicked) link color (<body alink=…>). */
	active: string | null;
}

/** Read one color attribute off a raw `<body …>` tag, normalizing bare hex and
 * rejecting anything that isn't a valid CSS color. */
const bodyAttrColor = (bodyTag: string, attr: string): string | null => {
	const match = bodyTag.match(
		new RegExp(`\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
	);
	if (!match) return null;
	let color = (match[2] ?? match[3] ?? match[4] ?? "").trim();
	if (/^[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) color = `#${color}`;
	return isValidCssColor(color) ? color : null;
};

/**
 * Pull the link/vlink/alink colors a page declares on `<body>` out of the RAW
 * (pre-sanitize) HTML — DOMPurify strips the <body> wrapper, so this must run
 * before sanitization, and the colors are re-applied as a shadow-root <style>.
 * Period pages often omit the leading '#', so bare hex is normalized.
 */
export const extractLinkColors = (html: string): BodyLinkColors => {
	const body = html.match(/<body\b[^>]*>/i);
	if (!body) return { link: null, visited: null, active: null };
	return {
		link: bodyAttrColor(body[0], "link"),
		visited: bodyAttrColor(body[0], "vlink"),
		active: bodyAttrColor(body[0], "alink"),
	};
};

/**
 * Build the shadow-root stylesheet that recreates the page's `<body>` link
 * colors. Visited uses our `.browserVisited` class (the browser can't be told a
 * proxied URL was visited); link/active use the real :link/:active pseudo-
 * classes. Rules are ordered link → visited → active so the cascade resolves
 * like a normal browser when a link is both visited and being pressed.
 */
export const buildLinkStyle = (colors: BodyLinkColors): string => {
	const rules: string[] = [];
	if (colors.link) rules.push(`a:link,area:link{color:${colors.link}}`);
	if (colors.visited)
		rules.push(
			`a.browserVisited,area.browserVisited{color:${colors.visited}}`,
		);
	if (colors.active) rules.push(`a:active,area:active{color:${colors.active}}`);
	return rules.join("\n");
};
