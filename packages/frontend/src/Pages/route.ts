/**
 * Which URLs belong to the CMS pages surface.
 *
 * Pages are served at the site root by their slug (`/about`), so the page router
 * is the catch-all and this rule is what keeps it from swallowing everything
 * else. Kept separate from PagesSite.tsx so app.tsx can decide the branch before
 * importing the surface at all.
 */

/**
 * Path segments the site itself answers, mirroring RESERVED_SLUGS in
 * packages/backend/pages-collections.mjs. In production nginx resolves these
 * from the docroot before the SPA fallback ever runs, so this is belt and
 * braces — but it keeps dev behaviour identical to production, and Directus
 * refuses these as slugs anyway.
 */
export const RESERVED_PATHS = ["assets", "img", "maps", "stacks"];

/**
 * The slug for a pathname, or null when the desktop should render instead.
 *
 * Null for: the root, reserved paths, anything with a file extension, and any
 * multi-segment path — slugs are deliberately flat, so `/about/team` is not a
 * page address even when a page is nested under another in the menu.
 */
export function pagesRouteSlug(pathname: string): string | null {
	const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
	if (trimmed === "") return null;

	const segments = trimmed.split("/");
	if (segments.length !== 1) return null;

	let slug: string;
	try {
		slug = decodeURIComponent(segments[0]);
	} catch {
		return null; // malformed percent-encoding is not a page address
	}

	if (slug.includes(".")) return null;
	if (RESERVED_PATHS.includes(slug)) return null;

	return slug;
}
