/**
 * migrate-news-item-links.mjs
 *
 * Rewrites `item.jsp?item=<slug>...` cross-reference links inside
 * `news_items.content` (History Commons article bodies) so the News app and
 * HyperCard's `directusNews` part can open them in-app instead of navigating
 * the SPA to a dead relative URL — see
 * packages/frontend/src/lib/newsContentLinks.ts for the click-side half of
 * this feature.
 *
 * Every news_items row's own permalink lives in its `url` field
 * (`http://historycommons.org/context.jsp?item=<slug>#<slug>`), so a
 * slug→id map built from every row's `url` is the join key back from a
 * cross-reference's `item=<slug>` to the row it should point at — the
 * original import (seed.mjs's transformNewsEntry) assigns a fresh Postgres
 * serial `id` on insert, so the id from the source JSON doesn't survive and
 * can't be used directly.
 *
 * historycommons.org itself is down, so a cross-reference whose slug isn't
 * one of our own rows (an item from a timeline this collection never
 * imported) is instead resolved through the Wayback Machine Availability API
 * (https://archive.org/wayback/available) — first against the item.jsp URL
 * as originally written, falling back to the canonical context.jsp permalink
 * form (more likely to have been crawled). If neither has an archived
 * snapshot, the link is rewritten to a plain, absolute historycommons.org
 * URL as a last resort (dead today, but at least a well-formed link) and
 * flagged in the report for manual follow-up.
 *
 * Usage:
 *   node migrate-news-item-links.mjs             # dry run (default) — no
 *                                                 # writes, prints a report
 *                                                 # and writes samples to
 *                                                 # ./migrate-news-item-links-report.json
 *   node migrate-news-item-links.mjs --apply      # writes the rewritten
 *                                                 # content, one row PATCH at
 *                                                 # a time
 *
 * Env:
 *   DIRECTUS_URL          required (no default — see requireEnv below)
 *   ADMIN_EMAIL           required only for --apply (news_items content is
 *   ADMIN_PASSWORD        anonymous-readable, so dry runs need neither)
 *
 * Idempotent: a second run finds no more item.jsp links to rewrite (the
 * href itself no longer matches), so it's safe to re-run after a partial
 * apply or as new content is authored.
 */
import { writeFile } from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing required environment variable: ${name}`);
		console.error(
			"Refusing to fall back to a default (e.g. localhost) — a silent default is how you configure the wrong instance.",
		);
		process.exit(1);
	}
	return value;
}

const DIRECTUS_URL = requireEnv("DIRECTUS_URL");

async function api(method, path, { token, body } = {}) {
	const res = await fetch(`${DIRECTUS_URL}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			"Cache-Control": "no-store",
		},
		body: body != null ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
	return text ? JSON.parse(text) : null;
}

async function login() {
	const email = requireEnv("ADMIN_EMAIL");
	const password = requireEnv("ADMIN_PASSWORD");
	const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`POST /auth/login → ${res.status}: ${text}`);
	return JSON.parse(text).data.access_token;
}

// --- Slug extraction -------------------------------------------------------

// Own permalink: http://historycommons.org/context.jsp?item=<slug>#<slug>
const PERMALINK_SLUG_RE = /context\.jsp\?item=([^#&"']+)/;

// A cross-reference href: item.jsp?item=<slug>[&timeline=<slug>][&other=...]
// Captured whole (group 2) so it can be replaced verbatim; group 3 is just
// the item= value, extracted separately below.
const CROSSREF_HREF_RE = /href=(["'])(item\.jsp\?[^"']*)\1/g;

function slugFromPermalink(url) {
	const m = typeof url === "string" ? url.match(PERMALINK_SLUG_RE) : null;
	return m ? m[1] : null;
}

function slugFromCrossrefHref(href) {
	// href is a relative URL fragment (item.jsp?item=x&timeline=y) — parse its
	// query string directly rather than resolving against a base URL.
	const qs = href.slice(href.indexOf("?") + 1).replace(/&amp;/g, "&");
	return new URLSearchParams(qs).get("item");
}

// --- Wayback Machine fallback ----------------------------------------------

const waybackCache = new Map(); // absolute url -> archived snapshot url | null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 429/5xx here means "unknown", not "not archived" — retry with backoff
// rather than silently recording a false dead-fallback. Confirmed necessary:
// archive.org's public availability endpoint 429'd during manual spot-checks
// even at a ~7 req/s sustained rate from this script.
async function waybackSnapshot(absoluteUrl, attempt = 1) {
	if (waybackCache.has(absoluteUrl)) return waybackCache.get(absoluteUrl);
	const res = await fetch(
		`https://archive.org/wayback/available?url=${encodeURIComponent(absoluteUrl)}`,
	);
	if (!res.ok) {
		if ((res.status === 429 || res.status >= 500) && attempt < 5) {
			await sleep(attempt * 2000);
			return waybackSnapshot(absoluteUrl, attempt + 1);
		}
		throw new Error(`Wayback availability lookup failed for ${absoluteUrl}: HTTP ${res.status}`);
	}
	const data = await res.json();
	const snapshotUrl = data?.archived_snapshots?.closest?.available
		? data.archived_snapshots.closest.url
		: null;
	waybackCache.set(absoluteUrl, snapshotUrl);
	// Be polite to a free public API doing a few thousand lookups in a row.
	await sleep(400);
	return snapshotUrl;
}

/**
 * Resolves an unmatched slug to an external link: an archived snapshot if
 * one exists, a dead-but-valid historycommons.org URL if genuinely
 * unarchived, or the same dead URL flagged as "lookup-error" if the Wayback
 * lookup itself failed (rate-limited past its retries, etc.) — kept distinct
 * from a genuine miss so the report doesn't quietly misreport an API outage
 * as "not archived".
 */
async function resolveExternalLink(slug, timelineParam) {
	const itemJspUrl = `http://historycommons.org/item.jsp?item=${slug}${
		timelineParam ? `&timeline=${timelineParam}` : ""
	}`;
	const permalinkUrl = `http://historycommons.org/context.jsp?item=${slug}`;

	try {
		const viaItemJsp = await waybackSnapshot(itemJspUrl);
		if (viaItemJsp) return { url: viaItemJsp, resolution: "wayback-item.jsp" };

		const viaPermalink = await waybackSnapshot(permalinkUrl);
		if (viaPermalink) return { url: viaPermalink, resolution: "wayback-context.jsp" };

		return { url: itemJspUrl, resolution: "dead-fallback" };
	} catch (err) {
		console.warn(`  Wayback lookup failed for slug "${slug}": ${err.message}`);
		return { url: itemJspUrl, resolution: "lookup-error" };
	}
}

// --- Row rewriting -----------------------------------------------------------

/**
 * Rewrites every cross-reference href in one row's content. Returns the new
 * content plus per-link resolution counts for the report; content is
 * returned unchanged (same string) if nothing matched.
 */
async function rewriteContent(content, slugToId) {
	const matches = [...content.matchAll(CROSSREF_HREF_RE)];
	if (matches.length === 0) return { content, stats: null };

	const counts = { internal: 0, "wayback-item.jsp": 0, "wayback-context.jsp": 0, "dead-fallback": 0, "lookup-error": 0 };
	let rewritten = content;
	// Replace back-to-front so earlier match indices stay valid.
	for (const match of matches.reverse()) {
		const [full, , href] = match;
		const slug = slugFromCrossrefHref(href);
		const timelineParam = new URLSearchParams(href.slice(href.indexOf("?") + 1).replace(/&amp;/g, "&")).get(
			"timeline",
		);

		let replacementHref;
		if (slug && slugToId.has(slug)) {
			replacementHref = `#/news-item/${slugToId.get(slug)}`;
			counts.internal++;
		} else if (slug) {
			const { url, resolution } = await resolveExternalLink(slug, timelineParam);
			replacementHref = url;
			counts[resolution]++;
		} else {
			continue; // href.jsp with no parseable item= — leave untouched
		}

		const start = match.index;
		const end = start + full.length;
		const quote = full[full.indexOf("=") + 1];
		rewritten = `${rewritten.slice(0, start)}href=${quote}${replacementHref}${quote}${rewritten.slice(end)}`;
	}

	return { content: rewritten, stats: counts };
}

// --- Main --------------------------------------------------------------------

console.log(
	APPLY ? "Applying news_items cross-reference link rewrites…" : "DRY RUN — no changes will be made (pass --apply to apply).",
);
console.log(`Target: ${DIRECTUS_URL}`);

console.log("Fetching news_items permalinks to build the slug→id map…");
const permalinkRows = (
	await api("GET", `/items/news_items?fields=id,url&filter[url][_nnull]=true&limit=-1`)
).data;
const slugToId = new Map();
for (const row of permalinkRows) {
	const slug = slugFromPermalink(row.url);
	if (slug) slugToId.set(slug, row.id);
}
console.log(`  ${permalinkRows.length} rows with a url, ${slugToId.size} unique slugs mapped.`);

console.log("Fetching news_items rows with an item.jsp cross-reference…");
const contentRows = (
	await api(
		"GET",
		`/items/news_items?fields=id,content&filter[content][_contains]=item.jsp&limit=-1`,
	)
).data;
console.log(`  ${contentRows.length} rows to process.`);

const totals = { rows: 0, internal: 0, "wayback-item.jsp": 0, "wayback-context.jsp": 0, "dead-fallback": 0, "lookup-error": 0 };
const samples = [];
// A Directus session token expires (15 min default) well before this script
// finishes — the Wayback lookups alone can take longer than that — so a PATCH
// re-logs in once on expiry and retries, rather than dying mid-run and
// leaving the remaining rows for a second invocation to pick up.
let token = APPLY ? await login() : null;
async function patchRow(id, content) {
	try {
		await api("PATCH", `/items/news_items/${id}`, { token, body: { content } });
	} catch (err) {
		if (!String(err.message).includes("TOKEN_EXPIRED")) throw err;
		console.log("  session token expired — re-authenticating…");
		token = await login();
		await api("PATCH", `/items/news_items/${id}`, { token, body: { content } });
	}
}

let processed = 0;
for (const row of contentRows) {
	const { content: newContent, stats } = await rewriteContent(row.content, slugToId);
	processed++;
	if (processed % 200 === 0) console.log(`  ...${processed}/${contentRows.length}`);
	if (!stats) continue;

	totals.rows++;
	for (const key of Object.keys(stats)) totals[key] += stats[key];

	if (samples.length < 15) samples.push({ id: row.id, before: row.content, after: newContent });

	if (APPLY && newContent !== row.content) {
		// Sequential on purpose — parallel Directus REST loops against this
		// instance have returned mixed-up response bodies before.
		await patchRow(row.id, newContent);
	}
}

const report = { generatedAt: new Date().toISOString(), applied: APPLY, totals, samples };
const reportPath = new URL("./migrate-news-item-links-report.json", import.meta.url);
await writeFile(reportPath, JSON.stringify(report, null, 2));

console.log("\n--- Summary ---");
console.log(`Rows with at least one cross-reference: ${totals.rows}`);
console.log(`  → resolved to an internal news_items row: ${totals.internal}`);
console.log(`  → resolved via Wayback (item.jsp form):   ${totals["wayback-item.jsp"]}`);
console.log(`  → resolved via Wayback (context.jsp form): ${totals["wayback-context.jsp"]}`);
console.log(`  → no archive found, left as a dead historycommons.org link: ${totals["dead-fallback"]}`);
console.log(`  → Wayback lookup failed (rate-limited/error), left as a dead historycommons.org link: ${totals["lookup-error"]}`);
console.log(`\nFull report (with before/after samples) written to ${reportPath.pathname}`);
console.log(APPLY ? "\nDone — content rewritten." : "\nDry run complete — pass --apply to write these changes.");
