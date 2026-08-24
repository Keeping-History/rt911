/**
 * Google Analytics for the CMS pages surface.
 *
 * The desktop branch gets GA for free: `ClassicyAppManagerProvider` takes
 * `gaMeasurementIds` and builds its own `analytics` instance with the GA plugin
 * (see app.tsx). The pages surface deliberately mounts *outside* that provider —
 * visiting /about must not boot the app manager or open a streamer socket — so
 * it would otherwise be the one part of the site with no tag at all. This module
 * is that tag: a dependency-free gtag.js loader, reporting to the SAME
 * measurement id so both surfaces land in one property.
 *
 * Only ever initialise this on the pages branch. Calling it on the desktop
 * branch too would put a second GA tag on the page alongside classicy's and
 * double-count every hit.
 */

/** The GA4 property both surfaces report to. Single source of truth: app.tsx
 *  hands this same constant to classicy for the desktop branch. */
export const GA_MEASUREMENT_ID = "G-YV25XK2Y3R";

/**
 * Hostnames allowed to report into the production GA4 property. Everything
 * else — `localhost` (dev server, vitest, Playwright, `preview:auth`) and
 * `keeping-history.github.io` (PR previews, which bake these same prod
 * `VITE_*` values) — boots the identical app.tsx/PagesSite.tsx and would
 * otherwise report real hits into production analytics. Confirmed 2026-08-24:
 * localhost sessions were 96% of a reported "traffic spike".
 */
const PRODUCTION_HOSTNAMES = new Set(["911realtime.org", "beta.911realtime.org"]);

/** True when running on a hostname allowed to report analytics. Exported so
 *  app.tsx can gate the desktop branch's `gaMeasurementIds`, which classicy
 *  wires up internally and this module never sees. */
export function isProductionHost(
	hostname: string = typeof window === "undefined" ? "" : window.location.hostname,
): boolean {
	return PRODUCTION_HOSTNAMES.has(hostname);
}

type GtagFn = (...args: unknown[]) => void;

declare global {
	interface Window {
		dataLayer?: unknown[];
		gtag?: GtagFn;
	}
}

let initialized = false;

/**
 * Inject gtag.js and configure the property. Idempotent — a second call is a
 * no-op, so React StrictMode's double-invoked effects can't add two tags.
 *
 * `send_page_view: false` is deliberate: this surface is a client-side router
 * (PagesSite pushState's between slugs), so the automatic pageview would only
 * ever fire for the first page a visitor landed on. Views are sent explicitly
 * by {@link trackPageView} instead — once on load and once per navigation.
 */
export function initGoogleAnalytics(
	measurementId: string = GA_MEASUREMENT_ID,
	hostname: string = typeof window === "undefined" ? "" : window.location.hostname,
): void {
	if (initialized) return;
	if (!measurementId || typeof document === "undefined") return;
	if (!isProductionHost(hostname)) return;
	initialized = true;

	window.dataLayer = window.dataLayer ?? [];

	// gtag.js reads the raw `arguments` object back off dataLayer; pushing a
	// plain rest-parameter array is NOT equivalent and the hits are ignored.
	// This must stay a classic function for that reason.
	function gtag() {
		// eslint-disable-next-line prefer-rest-params
		window.dataLayer?.push(arguments);
	}
	window.gtag = gtag as GtagFn;

	const script = document.createElement("script");
	script.async = true;
	script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
	document.head.appendChild(script);

	window.gtag("js", new Date());
	window.gtag("config", measurementId, { send_page_view: false });
}

export interface PageViewParams {
	/** Path of the page being viewed, e.g. "/about". */
	path: string;
	/** Document title at the time of the view. */
	title: string;
	/** True when the slug resolved to no published page (the 404 view). */
	notFound?: boolean;
}

/**
 * Report one page view. A no-op until {@link initGoogleAnalytics} has run, so
 * tests and any surface that never initialises stay silent.
 *
 * 404s are still reported — a page view is what happened — but carry a
 * `page_not_found` parameter so broken inbound links can be told apart from
 * real content in GA rather than looking like ordinary traffic.
 */
export function trackPageView({ path, title, notFound }: PageViewParams): void {
	if (!initialized || !window.gtag) return;
	window.gtag("event", "page_view", {
		page_path: path,
		page_title: title,
		page_location: `${window.location.origin}${path}`,
		...(notFound ? { page_not_found: true } : {}),
	});
}
