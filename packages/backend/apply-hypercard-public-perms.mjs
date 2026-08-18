/**
 * apply-hypercard-public-perms.mjs
 *
 * Grants the Directus public-policy read permissions the HyperCard stack
 * embeds need, and nothing else (issue #348). The HyperCard extension parts
 * fetch one row per embed anonymously over Directus REST —
 * `fetchDirectusItem()` in
 * packages/frontend/src/Applications/HyperCard/extensions/directusCollections.ts
 * does a plain `GET /items/<collection>/<id>?fields=…` with no auth — so every
 * collection in that registry needs a public read grant or the embed dies with
 * "HTTP 403".
 *
 * Grants (all read, all on the $t:public_label policy):
 *
 *   mp3_items     explicit fields, filtered to approved = 1
 *   news_items    explicit fields, filtered to approved = 1
 *   pager_items   explicit fields, filtered to approved = 1
 *   tv_channels   explicit fields, filtered to approved = 1
 *
 * Field lists are explicit, never ["*"] (the PAGES_PUBLIC_FIELDS precedent in
 * pages-collections.mjs): each is the union of what the HyperCard
 * DIRECTUS_COLLECTIONS registry requests and what the repo's other anonymous
 * REST readers request (the Playlist Editor's News browsing reads news_items —
 * see packages/frontend/src/Applications/PlaylistEditor/directusVolume.ts and
 * resolveTimelineMeta.ts). Requesting a field outside the granted list is
 * itself a 403 in Directus, so a too-narrow list reproduces the exact bug this
 * script fixes — any new field a frontend reader asks for must be added here.
 *
 * Every one of these tables has an integer `approved` column (1 = approved,
 * 0 = pending — see seed.mjs and the streamer's `WHERE … approved = 1`
 * queries in internal/db/postgres.go), and the streamer never delivers
 * unapproved rows. The `approved = 1` item filter on each grant keeps REST
 * consistent with that: unapproved rows stay invisible anonymously.
 *
 * news_items and tv_channels may already carry public grants (the Playlist
 * Editor work granted news_items read narrowed to id,title,source,start_date —
 * exactly why a HyperCard news embed asking for `content` 403s today). Those
 * are handled as drift, not skipped: the dry run reports existing-but-
 * different grants under "Would fix" and exits 1, and --apply PATCHes them to
 * the union field list. (A filter expressed as `{"approved":{"_eq":true}}`
 * also counts as drift against this script's integer `_eq: 1` — the column is
 * an integer; the PATCH normalizes it.)
 *
 * seed.mjs's ensurePublicReadAccess() creates the same grants on a fresh
 * install; this standalone script exists so an already-seeded instance (i.e.
 * production) can be converged without running seed.mjs, which bulk-imports
 * fixture data on import and must never be run just to fix permissions. The
 * two lists are kept in sync by hand — Dockerfile.seed bakes only seed.mjs,
 * so a shared module would break the seed image.
 *
 * Usage:
 *   node apply-hypercard-public-perms.mjs            # dry run (default) — prints
 *                                                     # the plan, makes no writes,
 *                                                     # issues only read requests;
 *                                                     # exits 1 if drift is found
 *   node apply-hypercard-public-perms.mjs --apply    # creates missing permission
 *                                                     # rows and corrects drifted
 *                                                     # ones
 *
 * Required env (no defaults, on purpose — a silent default is how you
 * configure the wrong instance):
 *   DIRECTUS_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 */

const APPLY = process.argv.includes("--apply");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error(
      "Refusing to fall back to a default (e.g. localhost) — a silent default is how you accidentally target the wrong Directus instance.",
    );
    process.exit(1);
  }
  return value;
}

const DIRECTUS_URL = requireEnv("DIRECTUS_URL");
const ADMIN_EMAIL = requireEnv("ADMIN_EMAIL");
const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");

// Same ~12-line api() wrapper apply-chat-permissions.mjs and seed.mjs use,
// duplicated rather than imported for the same reason apply-chat-schema.mjs
// duplicates it: no dependency on seed.mjs's top-level fixture-import side
// effects.
async function api(token, method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function login() {
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /auth/login → ${res.status}: ${text}`);
  const { data } = JSON.parse(text);
  return data.access_token;
}

async function findPolicyByName(token, name) {
  const res = await api(token, "GET", `/policies?filter[name][_eq]=${encodeURIComponent(name)}&fields=id,name&limit=1`);
  return res.data[0] ?? null;
}

// A missing grant and a wrong grant are different failures. A grant that
// exists but with a narrowed field list — exactly the misconfiguration that
// produced issue #348's 403s — must never be reported as "already granted."
// These helpers compare an existing /permissions row against the one this
// script expects, independent of key order (Directus does not guarantee the
// order it returns JSON object keys in) and independent of Directus
// normalizing an absent filter to `{}` on some routes and `null` on others —
// both mean "no restriction" and must compare equal to each other, not just
// to themselves.

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeFilter(filter) {
  if (filter == null) return null;
  if (typeof filter === "object" && !Array.isArray(filter) && Object.keys(filter).length === 0) return null;
  return filter;
}

function filtersEqual(a, b) {
  return stableStringify(normalizeFilter(a)) === stableStringify(normalizeFilter(b));
}

function fieldsEqual(a, b) {
  const sorted = (arr) => [...(arr ?? [])].sort();
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

// Compares an existing directus_permissions row (as returned by GET) against
// the grant this script wants in place. Every field this script ever sets is
// checked — a drifted `fields` (the narrowed news_items list) is exactly as
// much a drift as the approved filter itself, and this is the one function
// that decides whether re-running this script on a misconfigured instance
// stays silent or speaks up.
function grantMatches(existingRow, expected) {
  return (
    fieldsEqual(existingRow.fields, expected.fields) &&
    filtersEqual(existingRow.permissions, expected.permissions) &&
    filtersEqual(existingRow.validation, expected.validation) &&
    filtersEqual(existingRow.presets, expected.presets)
  );
}

function expectedGrantBody(grant) {
  return {
    fields: grant.fields,
    permissions: grant.permissions ?? null,
    validation: grant.validation ?? null,
    presets: grant.presets ?? null,
  };
}

// Integer, not boolean: `approved` is an integer column on all four tables
// (seed.mjs creates it with default 1; the streamer filters `approved = 1`).
const APPROVED_FILTER = { approved: { _eq: 1 } };

// Keep in sync with seed.mjs's PUBLIC_READ_GRANTS (fresh-install path) and
// with the frontend readers each field list is derived from.
const PUBLIC_GRANTS = [
  {
    // Union of HyperCard audio embeds (DIRECTUS_COLLECTIONS.audio) and the
    // Radio Tuner's station-logo lookup (`image`, read via source.slug — see
    // packages/frontend/src/Applications/RadioScanner/stationLogos.ts). The
    // tuner needs a station's artwork even when that station has nothing
    // streaming, which is most of the day for the one-recording stations, so
    // it cannot rely on the WebSocket items alone.
    //
    // `peaks` is the 480-bucket amplitude envelope the Playlist Editor's lane
    // waveform draws (usePeaksForSpan.ts asks for it by name in `fields`).
    //
    // The derived-metadata columns — subject, link, tier, confidence, evidence,
    // participants, mentions, provenance — are the redacted public projection of
    // `parties`, materialised by video-grabber's build_public_meta (see
    // packages/tools/video-grabber/video_grabber/parties/public_meta.py). They
    // are granted; `parties` itself deliberately is NOT. The whole point of the
    // projection is that the private blob's QA signals (`gate_reasons`, `model`)
    // stay 403 to anonymous readers, so adding `parties` here would undo it.
    // `tags_curated` is curator input rather than published output, and
    // `derived_at` is an internal derivation-version marker with no reader —
    // both stay ungranted for the same reason.
    collection: "mp3_items",
    action: "read",
    fields: [
      "id", "title", "full_title", "url", "source", "start_date", "calc_duration", "subtitles", "image", "peaks",
      "subject", "link", "tier", "confidence", "evidence", "participants", "mentions", "provenance",
    ],
    permissions: APPROVED_FILTER,
  },
  {
    // Union of HyperCard news embeds (DIRECTUS_COLLECTIONS.news) and the
    // Playlist Editor's News browsing (directusVolume.ts filters/groups by
    // `source` — a filter field must be readable or the query 403s —
    // resolveTimelineMeta.ts reads start_date).
    collection: "news_items",
    action: "read",
    fields: ["id", "title", "full_title", "content", "start_date", "image", "image_caption", "url", "format", "source"],
    permissions: APPROVED_FILTER,
  },
  {
    // HyperCard pager embeds (DIRECTUS_COLLECTIONS.pager) — the only
    // anonymous REST reader of pager_items.
    collection: "pager_items",
    action: "read",
    fields: ["id", "start_date", "provider", "recipient_id", "id_type", "channel", "mode", "message"],
    permissions: APPROVED_FILTER,
  },
  {
    // HyperCard video embeds (DIRECTUS_COLLECTIONS.video) — the stitched
    // continuous channel rows, including the subtitles URL and the
    // start/end window the embed maps wall-clock instants onto.
    collection: "tv_channels",
    action: "read",
    fields: ["id", "title", "full_title", "url", "source", "start_date", "end_date", "calc_duration", "timezone", "subtitles"],
    permissions: APPROVED_FILTER,
  },
];

console.log(APPLY ? "Applying HyperCard embed public read permissions…" : "DRY RUN — no changes will be made (pass --apply to apply).");
console.log(`Target: ${DIRECTUS_URL}`);

const token = await login();
console.log("Authenticated.");

const publicPolicy = await findPolicyByName(token, "$t:public_label");
if (!publicPolicy) {
  console.error("Public policy ($t:public_label) not found — cannot grant public read on the HyperCard embed collections.");
  process.exit(1);
}
console.log(`Public policy: ${publicPolicy.id}`);

// One fetch covers every existing grant this script cares about, so the
// per-collection checks below are pure in-memory lookups rather than a
// GET per candidate grant.
const existingOnPublicPolicy = await api(token, "GET", `/permissions?filter[policy][_eq]=${publicPolicy.id}&limit=-1`);

function findExistingGrant(collection, action) {
  return existingOnPublicPolicy.data.find((p) => p.collection === collection && p.action === action) ?? null;
}

const toCreate = [];
const toSkip = [];
const toFix = [];

for (const grant of PUBLIC_GRANTS) {
  const expected = expectedGrantBody(grant);
  const existingRow = findExistingGrant(grant.collection, grant.action);
  if (!existingRow) {
    toCreate.push(grant);
  } else if (grantMatches(existingRow, expected)) {
    toSkip.push(grant);
  } else {
    toFix.push({ ...grant, permissionId: existingRow.id, existingRow, expected });
  }
}

function describe(entry) {
  return `Public policy — ${entry.collection}.${entry.action}`;
}

console.log("\nCurrent state:");
for (const grant of PUBLIC_GRANTS) {
  const state = toSkip.includes(grant) ? "grant present and correct"
    : toCreate.includes(grant) ? "grant ABSENT (anonymous reads 403)"
    : "grant DRIFTED (exists, but fields/filter differ)";
  console.log(`  - ${grant.collection}: ${state}`);
}

if (!APPLY) {
  console.log("\nWould create:");
  if (toCreate.length === 0) console.log("  (none — every grant already exists)");
  for (const entry of toCreate) console.log(`  - ${describe(entry)}`);

  console.log("\nWould fix (DRIFT DETECTED — existing grant does not match the intended filter/fields):");
  if (toFix.length === 0) console.log("  (none)");
  for (const entry of toFix) {
    console.log(`  - ${describe(entry)} (permission id=${entry.permissionId})`);
    console.log(`      existing: fields=${stableStringify(entry.existingRow.fields)} permissions=${stableStringify(entry.existingRow.permissions)} validation=${stableStringify(entry.existingRow.validation)} presets=${stableStringify(entry.existingRow.presets)}`);
    console.log(`      expected: fields=${stableStringify(entry.expected.fields)} permissions=${stableStringify(entry.expected.permissions)} validation=${stableStringify(entry.expected.validation)} presets=${stableStringify(entry.expected.presets)}`);
  }

  console.log("\nWould skip (already correct):");
  if (toSkip.length === 0) console.log("  (none)");
  for (const entry of toSkip) console.log(`  - ${describe(entry)}`);

  if (toFix.length > 0) {
    console.error("\n*** DRIFT DETECTED on the grants above. Re-run with --apply to correct them. ***");
  }
  console.log("\nDry run complete. Re-run with --apply to make these changes.");
  process.exit(toFix.length > 0 ? 1 : 0);
}

const created = [];
for (const entry of toCreate) {
  console.log(`Granting: ${describe(entry)}`);
  const body = { policy: publicPolicy.id, collection: entry.collection, action: entry.action, ...expectedGrantBody(entry) };
  await api(token, "POST", "/permissions", body);
  created.push(entry);
}

const fixed = [];
for (const entry of toFix) {
  console.log(`Correcting drift: ${describe(entry)} (permission id=${entry.permissionId})`);
  await api(token, "PATCH", `/permissions/${entry.permissionId}`, entry.expected);
  fixed.push(entry);
}

for (const entry of toSkip) {
  console.log(`Already correct, skipping: ${describe(entry)}`);
}

console.log("\n--- Summary ---");
console.log(`Created (${created.length}): ${created.map(describe).join(", ") || "(none)"}`);
console.log(`Fixed (${fixed.length}): ${fixed.map(describe).join(", ") || "(none)"}`);
console.log(`Skipped (${toSkip.length}): ${toSkip.map(describe).join(", ") || "(none)"}`);
