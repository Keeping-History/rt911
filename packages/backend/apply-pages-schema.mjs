/**
 * apply-pages-schema.mjs
 *
 * Creates the `pages` and `page_authors` Directus collections, their
 * relations, and their public read grants. See
 * plans/2026-08-06-cms-pages-design.md.
 *
 * Why this exists instead of seed.mjs: seed.mjs looks like a schema script
 * but isn't one. Its top-level module body runs createCollections() and then
 * bulk-imports local JSON fixtures (media, mp3, news, pager) into whatever
 * DIRECTUS_URL points at. Merely importing it executes that. This script
 * shares nothing with it.
 *
 * Usage:
 *   node apply-pages-schema.mjs            # dry run (default) — prints the
 *                                          # plan, issues only reads
 *   node apply-pages-schema.mjs --apply    # creates what is missing
 *   node apply-pages-schema.mjs --verify   # reads the live schema back and
 *                                          # asserts it matches; exits 1 on
 *                                          # any drift
 *
 * Required env (no defaults, on purpose — a silent localhost default is how
 * you accidentally target the wrong Directus instance):
 *   DIRECTUS_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 */

import {
  PAGE_COLLECTIONS,
  PAGES_RELATIONS,
  PAGES_PERMISSIONS,
  RESERVED_SLUGS,
} from "./pages-collections.mjs";

const APPLY = process.argv.includes("--apply");
const VERIFY = process.argv.includes("--verify");

if (APPLY && VERIFY) {
  console.error("--apply and --verify are mutually exclusive; run them one at a time.");
  process.exit(1);
}

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

/**
 * Internal consistency check on the definitions themselves. Runs in every
 * mode, before any network call. Every failure here would otherwise surface
 * as an opaque Directus 400 halfway through an apply, leaving the schema
 * half-created.
 */
function preflight() {
  const problems = [];

  if (RESERVED_SLUGS.length === 0) {
    problems.push("RESERVED_SLUGS is empty — the slug validation filter would allow every path.");
  }

  const declared = new Map();
  for (const col of PAGE_COLLECTIONS) {
    const names = col.fields.map((f) => f.field);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) problems.push(`${col.collection}: duplicate field(s) ${[...new Set(dupes)].join(", ")}`);
    if (!names.includes("id")) problems.push(`${col.collection}: no primary key field declared`);
    declared.set(col.collection, new Set(names));
  }

  for (const rel of PAGES_RELATIONS) {
    const fields = declared.get(rel.collection);
    if (!fields) {
      problems.push(`relation ${rel.collection}.${rel.field}: collection is not defined in PAGE_COLLECTIONS`);
    } else if (!fields.has(rel.field)) {
      problems.push(`relation ${rel.collection}.${rel.field}: no such field declared`);
    }
    // directus_* are built-ins and legitimately absent from PAGE_COLLECTIONS.
    if (!declared.has(rel.related_collection) && !rel.related_collection.startsWith("directus_")) {
      problems.push(`relation ${rel.collection}.${rel.field} → ${rel.related_collection}: unknown target collection`);
    }
  }

  const known = new Set(PAGE_COLLECTIONS.map((c) => c.collection));
  for (const p of PAGES_PERMISSIONS) {
    if (!known.has(p.collection)) problems.push(`permission on ${p.collection}: not defined in PAGE_COLLECTIONS`);
  }

  // page_authors must be created before pages, because pages.author is an
  // M2O onto it.
  const order = PAGE_COLLECTIONS.map((c) => c.collection);
  if (order.indexOf("page_authors") > order.indexOf("pages")) {
    problems.push("PAGE_COLLECTIONS order: page_authors must come before pages (pages.author references it)");
  }

  if (problems.length) {
    console.error("Preflight failed — the definitions are internally inconsistent:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

async function login() {
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`login failed: ${res.status} ${text}`);
  return JSON.parse(text).data.access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // The body is the only useful diagnostic on a Directus schema 400.
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function exists(token, path) {
  try {
    await api(token, "GET", path);
    return true;
  } catch {
    return false;
  }
}

preflight();
console.log(`preflight ok — ${PAGE_COLLECTIONS.length} collection(s), ${PAGES_RELATIONS.length} relation(s), ${PAGES_PERMISSIONS.length} permission(s)`);
console.log(`target: ${DIRECTUS_URL}`);

const token = await login();

// --- Plan -------------------------------------------------------------
const plan = { collections: [], relations: [], permissions: [] };

for (const col of PAGE_COLLECTIONS) {
  if (!(await exists(token, `/collections/${col.collection}`))) plan.collections.push(col.collection);
}

const liveRelations = (await api(token, "GET", "/relations?limit=-1")).data ?? [];
const relKey = (c, f) => `${c}.${f}`;
const liveRelKeys = new Set(liveRelations.map((r) => relKey(r.collection, r.field)));
for (const rel of PAGES_RELATIONS) {
  if (!liveRelKeys.has(relKey(rel.collection, rel.field))) plan.relations.push(relKey(rel.collection, rel.field));
}

const publicPolicy = await findPublicPolicy(token);
const livePerms = (await api(token, "GET", `/permissions?filter[policy][_eq]=${publicPolicy}&limit=-1`)).data ?? [];
for (const p of PAGES_PERMISSIONS) {
  const match = livePerms.find((lp) => lp.collection === p.collection && lp.action === p.action);
  if (!match) plan.permissions.push(`${p.collection}:${p.action} (create)`);
  else if (JSON.stringify(match.permissions ?? {}) !== JSON.stringify(p.permissions))
    plan.permissions.push(`${p.collection}:${p.action} (DRIFT — live filter ${JSON.stringify(match.permissions)}, expected ${JSON.stringify(p.permissions)})`);
}

async function findPublicPolicy(tok) {
  const rows = (await api(tok, "GET", "/policies?fields=id,name,roles.role,roles.user&limit=-1")).data ?? [];
  // Directus 12 always returns a non-empty `roles` array — those are
  // directus_access junction rows, not role ids. The public policy is the
  // one whose access rows bind to neither a role nor a user.
  const found = rows.filter(
    (r) => Array.isArray(r.roles) && r.roles.length > 0 && r.roles.every((a) => !a.role && !a.user),
  );
  if (found.length !== 1) {
    throw new Error(
      `expected exactly 1 public policy, found ${found.length}: ` +
        JSON.stringify(rows.map((r) => ({ id: r.id, name: r.name, roles: r.roles }))),
    );
  }
  return found[0].id;
}

console.log("\nPlan:");
console.log(`  collections to create: ${plan.collections.length ? plan.collections.join(", ") : "(none — all present)"}`);
console.log(`  relations to create:   ${plan.relations.length ? plan.relations.join(", ") : "(none — all present)"}`);
console.log(`  permissions:           ${plan.permissions.length ? plan.permissions.join(", ") : "(none — all present)"}`);
console.log(`  public policy id:      ${publicPolicy}`);

if (APPLY) {
  // Sequential, never concurrent. Bursts of schema operations wedge
  // Directus's introspection cache and require an rt911-api pod restart to
  // recover (observed previously in this project).
  for (const col of PAGE_COLLECTIONS) {
    if (!plan.collections.includes(col.collection)) {
      console.log(`collection ${col.collection}: already present, skipping`);
      continue;
    }
    console.log(`creating collection ${col.collection}`);
    await api(token, "POST", "/collections", col);
  }

  for (const rel of PAGES_RELATIONS) {
    const key = relKey(rel.collection, rel.field);
    if (!plan.relations.includes(key)) {
      console.log(`relation ${key}: already present, skipping`);
      continue;
    }
    console.log(`creating relation ${key} → ${rel.related_collection}`);
    await api(token, "POST", "/relations", rel);
  }

  for (const p of PAGES_PERMISSIONS) {
    const match = livePerms.find((lp) => lp.collection === p.collection && lp.action === p.action);
    if (match) {
      // Drift is reported, never silently overwritten — an operator may have
      // narrowed this grant deliberately.
      const drifted = JSON.stringify(match.permissions ?? {}) !== JSON.stringify(p.permissions);
      console.log(
        drifted
          ? `permission ${p.collection}:${p.action}: EXISTS BUT DRIFTED — left alone. Live filter ${JSON.stringify(match.permissions)}, expected ${JSON.stringify(p.permissions)}. Reconcile by hand.`
          : `permission ${p.collection}:${p.action}: already present, skipping`,
      );
      continue;
    }
    console.log(`granting public ${p.action} on ${p.collection}`);
    await api(token, "POST", "/permissions", { policy: publicPolicy, ...p });
  }

  console.log("\napply complete — run with --verify to confirm the live schema matches");
} else if (!VERIFY) {
  console.log("\ndry run complete — re-run with --apply to change anything");
}
