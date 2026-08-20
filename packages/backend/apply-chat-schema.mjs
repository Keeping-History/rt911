/**
 * apply-chat-schema.mjs
 *
 * Applies ONLY the nine IM Buddies `chat_*` Directus collections (and their
 * indexes) to whatever DIRECTUS_URL points at.
 *
 * Why this exists instead of seed.mjs: seed.mjs looks like a schema script
 * but isn't one — its top-level module body runs createCollections() and
 * then importSources/importMediaItems/importMp3Items/importNewsItems/
 * importPagerItems, bulk-loading local JSON fixtures (entries_media.json,
 * entries_news.json, pager_entries.json) into whatever database
 * DIRECTUS_URL/PSQL_URL point at. Against a live instance — 24k+ sources
 * rows, 447k+ pager rows in prod — running seed.mjs just to add nine new
 * collections would also attempt to (re-)import all of that historical
 * data. This script imports the collection/index definitions from
 * chat-collections.mjs (the single shared source of truth with seed.mjs)
 * and does nothing else: no fixture loading, no import* functions, no
 * dependency on seed.mjs at all (importing seed.mjs would execute its
 * top-level side effects the moment the module loads).
 *
 * Usage:
 *   node apply-chat-schema.mjs            # dry run (default) — prints the
 *                                          # plan, makes no changes, issues
 *                                          # only read requests (login + GET
 *                                          # /collections)
 *   node apply-chat-schema.mjs --apply    # actually creates the missing
 *                                          # collections and applies the
 *                                          # chat index SQL
 *
 * Required env (same names seed.mjs uses — no defaults, on purpose): *
 *   DIRECTUS_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 * Optional env:
 *   PSQL_URL — if set, CHAT_INDEX_SQL is piped into `psql $PSQL_URL`. If
 *   not set, in --apply mode the SQL is printed for the operator to run by
 *   hand instead of being silently skipped.
 */

import { spawnSync } from "node:child_process";
import { CHAT_COLLECTIONS, CHAT_INDEX_SQL } from "./chat-collections.mjs";

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

// Duplicated (not imported) from seed.mjs on purpose: importing seed.mjs
// would run its top-level module body, which authenticates and then
// bulk-imports sources/media/mp3/news/pager fixture data — exactly what
// this narrow script exists to avoid. This is the same ~12-line api()
// wrapper seed.mjs uses; keeping it in sync manually is an acceptable cost
// for never accidentally pulling in seed.mjs's import* side effects.
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

// One-shot login, no retry loop — unlike seed.mjs's getToken (which retries
// on 503 for a docker-compose stack that might still be booting), this
// script targets an already-running instance, so a failed login is a real
// failure, not a "not ready yet."
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

// Same PSQL_URL-gated mechanism as seed.mjs's psql(sql), minus its
// docker-compose fallback — that fallback exists for the local dev stack;
// this script targets a real instance, so there is no sensible "docker
// compose exec" fallback here. If PSQL_URL isn't set, print the SQL rather
// than silently skipping it.
function applyIndexSql() {
  const psqlUrl = process.env.PSQL_URL;
  if (!psqlUrl) {
    console.log("\nPSQL_URL not set — skipping automatic index creation. Run this by hand:\n");
    console.log(CHAT_INDEX_SQL);
    return false;
  }
  const result = spawnSync("psql", [psqlUrl, "-v", "ON_ERROR_STOP=1"], {
    input: CHAT_INDEX_SQL,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`psql failed:\n${result.stderr || result.stdout}`);
  }
  return true;
}

console.log(APPLY ? "Applying IM Buddies chat_* schema…" : "DRY RUN — no changes will be made (pass --apply to apply).");
console.log(`Target: ${DIRECTUS_URL}`);

const token = await login();
console.log("Authenticated.");

const existing = await api(token, "GET", "/collections");
const names = existing.data.map((c) => c.collection);

const toCreate = CHAT_COLLECTIONS.filter((spec) => !names.includes(spec.collection));
const toSkip = CHAT_COLLECTIONS.filter((spec) => names.includes(spec.collection));

if (!APPLY) {
  console.log("\nWould create:");
  if (toCreate.length === 0) console.log("  (none — all nine collections already exist)");
  for (const spec of toCreate) console.log(`  - ${spec.collection}`);

  console.log("\nWould skip (already exist):");
  if (toSkip.length === 0) console.log("  (none)");
  for (const spec of toSkip) console.log(`  - ${spec.collection}`);

  console.log("\nWould apply this index SQL:");
  console.log(CHAT_INDEX_SQL);

  console.log("\nDry run complete. Re-run with --apply to make these changes.");
  process.exit(0);
}

const created = [];
for (const spec of toCreate) {
  console.log(`Creating collection: ${spec.collection}`);
  await api(token, "POST", "/collections", spec);
  created.push(spec.collection);
}
for (const spec of toSkip) {
  console.log(`Collection ${spec.collection} already exists, skipping.`);
}

const indexesApplied = applyIndexSql();

console.log("\n--- Summary ---");
console.log(`Created (${created.length}): ${created.join(", ") || "(none)"}`);
console.log(`Skipped (${toSkip.length}): ${toSkip.map((s) => s.collection).join(", ") || "(none)"}`);
console.log(`Indexes applied: ${indexesApplied ? "yes (via PSQL_URL)" : "no — printed above, run manually"}`);
