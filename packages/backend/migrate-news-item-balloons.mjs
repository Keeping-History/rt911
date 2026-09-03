/**
 * migrate-news-item-balloons.mjs
 *
 * Strips the dead `onmouseover="return OL('...')" onmouseout="return nd()"`
 * pair historycommons.org authored on every `<a>` in `news_items.content` —
 * `OL()`/`nd()` (its overLIB tooltip library) don't exist in this app, so
 * hovering any link throws a ReferenceError today. In its place, each anchor
 * gets `data-balloon-title="<text>"`: the click-side companion
 * (packages/frontend/src/lib/useNewsContentBalloon.ts, wired into the News
 * app and HyperCard's directusNews part) reads that attribute to show a real
 * Classicy Balloon on hover.
 *
 * Two different sources feed that title, chosen per anchor:
 *   - An internal cross-reference (href="#/news-item/<id>", rewritten by
 *     migrate-news-item-links.mjs — run that one first) gets the TARGET
 *     row's own current title (full_title, falling back to title) — the
 *     canonical answer to "what is this a link to", not the original site's
 *     (possibly stale/truncated) preview snapshot.
 *   - Every other link (external citations — CNN, NYT, book references, …)
 *     keeps the original OL() text verbatim (decoded/cleaned), since there's
 *     no "news item" to look up for those.
 *
 * Usage:
 *   node migrate-news-item-balloons.mjs             # dry run (default)
 *   node migrate-news-item-balloons.mjs --apply      # writes the rewritten
 *                                                     # content, one row
 *                                                     # PATCH at a time
 *
 * Env: DIRECTUS_URL required always; ADMIN_EMAIL/ADMIN_PASSWORD required
 * only for --apply (news_items content is anonymous-readable).
 *
 * Idempotent: a second run finds no more onmouseover to strip.
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

// --- Entity decoding / text cleanup -----------------------------------------

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntitiesOnce(s) {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent) => {
		if (ent[0] === "#") {
			const code =
				ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		return ent in NAMED_ENTITIES ? NAMED_ENTITIES[ent] : m;
	});
}

// The source double-escapes entities (&amp;lt; for a literal &lt;) — decode to
// a fixpoint rather than once. Capped so malformed input can't loop forever.
function decodeEntities(s) {
	let prev = s;
	for (let i = 0; i < 4; i++) {
		const next = decodeEntitiesOnce(prev);
		if (next === prev) return next;
		prev = next;
	}
	return prev;
}

/** Cleans an extracted OL() argument into plain balloon text: unescape the JS string, decode entities, strip any leftover markup (e.g. <em>). */
function cleanBalloonText(raw) {
	const unescaped = raw.replace(/\\(.)/g, "$1");
	return decodeEntities(unescaped).replace(/<[^>]*>/g, "").trim();
}

function escapeAttr(s) {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Anchor rewriting --------------------------------------------------------

const ANCHOR_TAG_RE = /<a\b[^>]*>/g;
const HREF_RE = /href\s*=\s*(["'])(.*?)\1/;
const OL_RE = /onmouseover\s*=\s*"return OL\('((?:\\.|[^'\\])*)'\)"/;
const ND_RE = /\s*onmouseout\s*=\s*"return nd\(\)"/;
const INTERNAL_HREF_RE = /^#\/news-item\/(\d+)$/;

/**
 * Rewrites one anchor tag: strips onmouseover/onmouseout, adds
 * data-balloon-title. Returns the tag unchanged if it has no OL() call to
 * replace.
 */
function rewriteAnchorTag(tag, idToTitle) {
	const olMatch = tag.match(OL_RE);
	if (!olMatch) return { tag, resolution: null };

	const hrefMatch = tag.match(HREF_RE);
	const internalId = hrefMatch ? hrefMatch[2].match(INTERNAL_HREF_RE)?.[1] : null;

	let title;
	let resolution;
	if (internalId && idToTitle.has(Number(internalId))) {
		title = idToTitle.get(Number(internalId));
		resolution = "internal-title";
	} else {
		title = cleanBalloonText(olMatch[1]);
		resolution = "external-citation";
	}
	if (!title) return { tag: tag.replace(OL_RE, "").replace(ND_RE, ""), resolution: "empty" };

	const stripped = tag.replace(OL_RE, "").replace(ND_RE, "");
	const withBalloon = stripped.replace(/>$/, ` data-balloon-title="${escapeAttr(title)}">`);
	return { tag: withBalloon, resolution };
}

function rewriteContent(content, idToTitle) {
	const counts = { "internal-title": 0, "external-citation": 0, empty: 0 };
	let touched = false;
	const rewritten = content.replace(ANCHOR_TAG_RE, (tag) => {
		const { tag: newTag, resolution } = rewriteAnchorTag(tag, idToTitle);
		if (resolution) {
			touched = true;
			counts[resolution]++;
		}
		return newTag;
	});
	return touched ? { content: rewritten, stats: counts } : { content, stats: null };
}

// --- Main --------------------------------------------------------------------

console.log(
	APPLY ? "Applying news_items balloon-title rewrites…" : "DRY RUN — no changes will be made (pass --apply to apply).",
);
console.log(`Target: ${DIRECTUS_URL}`);

console.log("Fetching news_items titles for the internal-link id→title map…");
const titleRows = (await api("GET", `/items/news_items?fields=id,title,full_title&limit=-1`)).data;
const idToTitle = new Map();
for (const row of titleRows) {
	const title = (row.full_title || row.title || "").trim();
	if (title) idToTitle.set(row.id, title);
}
console.log(`  ${titleRows.length} rows, ${idToTitle.size} with a usable title.`);

console.log("Fetching news_items rows with a dead onmouseover…");
const contentRows = (
	await api("GET", `/items/news_items?fields=id,content&filter[content][_contains]=onmouseover&limit=-1`)
).data;
console.log(`  ${contentRows.length} rows to process.`);

const totals = { rows: 0, "internal-title": 0, "external-citation": 0, empty: 0 };
const samples = [];
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
	const { content: newContent, stats } = rewriteContent(row.content, idToTitle);
	processed++;
	if (processed % 500 === 0) console.log(`  ...${processed}/${contentRows.length}`);
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
const reportPath = new URL("./migrate-news-item-balloons-report.json", import.meta.url);
await writeFile(reportPath, JSON.stringify(report, null, 2));

console.log("\n--- Summary ---");
console.log(`Rows with at least one dead onmouseover: ${totals.rows}`);
console.log(`  → internal cross-reference, title from the target row: ${totals["internal-title"]}`);
console.log(`  → external citation, kept original text:               ${totals["external-citation"]}`);
console.log(`  → resolved to empty text (attribute stripped, no balloon): ${totals.empty}`);
console.log(`\nFull report (with before/after samples) written to ${reportPath.pathname}`);
console.log(APPLY ? "\nDone — content rewritten." : "\nDry run complete — pass --apply to write these changes.");
