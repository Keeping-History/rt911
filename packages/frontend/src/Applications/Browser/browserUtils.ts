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
