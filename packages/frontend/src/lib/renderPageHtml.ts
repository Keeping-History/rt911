import DOMPurify from "dompurify";

/**
 * Sanitizer for CMS page bodies authored in Directus (see
 * plans/2026-08-06-cms-pages-design.md).
 *
 * Page bodies are rich text written by Directus users, so the threat model is a
 * careless or compromised author account rather than an anonymous attacker.
 * DOMPurify handles the general case; the extra pass here exists for one reason:
 * pages need to embed video, embedding video needs <iframe>, and DOMPurify drops
 * <iframe> entirely by default. Re-admitting the tag without constraining where
 * it can point would turn "an author can embed a video" into "an author can frame
 * anything at all", so the src is checked against an allowlist afterwards.
 *
 * Standalone (not folded into an app) so README and Browser can adopt it later
 * without being forced to now.
 */

export interface AllowedEmbed {
	host: string;
	/** Required path prefix. Host alone is not enough — see ALLOWED_EMBEDS. */
	pathPrefix: string;
}

/**
 * Allowlisted embed sources.
 *
 * The path prefix is not decoration. Allowing `www.youtube.com` by host alone
 * would admit `https://www.youtube.com/<anything>` — arbitrary YouTube pages
 * framed inside the site — so only the dedicated `/embed/` player path is
 * accepted. Same reasoning for the others.
 */
export const ALLOWED_EMBEDS: AllowedEmbed[] = [
	{ host: "www.youtube-nocookie.com", pathPrefix: "/embed/" },
	{ host: "youtube-nocookie.com", pathPrefix: "/embed/" },
	{ host: "www.youtube.com", pathPrefix: "/embed/" },
	{ host: "youtube.com", pathPrefix: "/embed/" },
	{ host: "player.vimeo.com", pathPrefix: "/video/" },
	{ host: "archive.org", pathPrefix: "/embed/" },
	{ host: "www.archive.org", pathPrefix: "/embed/" },
];

/**
 * Attributes an embed legitimately needs. Deliberately absent: `srcdoc`, which
 * lets an iframe carry its own inline document and would sidestep the src
 * allowlist completely. `sandbox` is absent too — an author-supplied sandbox
 * value can only ever loosen what we would otherwise enforce.
 */
const IFRAME_ATTRS = [
	"allow",
	"allowfullscreen",
	"frameborder",
	"width",
	"height",
	"title",
	"loading",
	"referrerpolicy",
];

/**
 * True when `src` is an https URL on the allowlist, matching both host and path.
 *
 * Parsing with `URL` rather than string-matching is what rejects the awkward
 * cases: a relative or protocol-relative src throws and is refused, and
 * `javascript:alert(1)` parses successfully but fails the protocol check — which
 * is why that check cannot be dropped as redundant.
 */
export function isAllowedEmbedSrc(src: string | null | undefined): boolean {
	if (!src) return false;
	let url: URL;
	try {
		url = new URL(src);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") return false;
	return ALLOWED_EMBEDS.some(
		(a) => url.host === a.host && url.pathname.startsWith(a.pathPrefix),
	);
}

/**
 * Class placed on the wrapper this module puts around every authored table.
 *
 * Exported so the stylesheet's `:global()` selector and the tests name the same
 * string. A `<table>` cannot both fill the reading column and scroll when it is
 * wider than the frame: `display: block` on the table itself buys the scroll,
 * but then `width: 100%` sizes the block box while the anonymous table box
 * inside it shrink-to-fits, so row bands stop short of the right edge. A
 * wrapper keeps the table a real table and moves the overflow off it. Authors
 * write plain `<table>` in Directus, so the wrapper has to be added here.
 */
export const TABLE_WRAPPER_CLASS = "pageTableScroll";

/**
 * Wrap each authored table in a horizontally scrollable block.
 *
 * Only outermost tables are wrapped: a table nested in a cell already scrolls
 * with its ancestor, and wrapping it would put a second scrollbar inside the
 * first. Re-wrapping is skipped so the function is safe over already-wrapped
 * markup.
 */
function wrapTables(root: DocumentFragment): void {
	for (const table of Array.from(root.querySelectorAll("table"))) {
		const parent = table.parentElement;
		// `parent?.closest` rather than `table.closest`: closest() matches the
		// element itself, so asking the table would find the table.
		if (parent?.closest("table")) continue;
		if (parent?.classList.contains(TABLE_WRAPPER_CLASS)) continue;

		const wrapper = document.createElement("div");
		wrapper.className = TABLE_WRAPPER_CLASS;
		table.replaceWith(wrapper);
		wrapper.appendChild(table);
	}
}

/**
 * Sanitize a Directus page body into HTML safe to inject.
 *
 * Returns a string for `dangerouslySetInnerHTML`, matching how Browser.tsx and
 * ReadmeContent.tsx already render sanitized HTML in this codebase.
 */
export function renderPageHtml(dirty: string | null | undefined): string {
	if (!dirty) return "";

	const clean = DOMPurify.sanitize(dirty, {
		ADD_TAGS: ["iframe"],
		ADD_ATTR: IFRAME_ATTRS,
	});

	// Second pass over the sanitized output. `template` parses without running
	// scripts, loading images, or otherwise touching the live document.
	const tpl = document.createElement("template");
	tpl.innerHTML = clean;

	for (const frame of Array.from(tpl.content.querySelectorAll("iframe"))) {
		// The srcdoc arm is defence in depth and does not fire today: DOMPurify's
		// default attribute allowlist already drops srcdoc, and it is deliberately
		// absent from ADD_ATTR. It stays so that a future DOMPurify default which
		// admits the attribute cannot silently reopen the bypass. An iframe left
		// with no usable src after that stripping is removed by the second arm.
		if (frame.hasAttribute("srcdoc") || !isAllowedEmbedSrc(frame.getAttribute("src"))) {
			frame.remove();
		}
	}

	// Presentation, not security — but it runs on the same already-parsed tree,
	// and after sanitizing so it can never reintroduce a dropped element.
	wrapTables(tpl.content);

	return tpl.innerHTML;
}
