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
 *
 * Limitation: --apply creates missing collections wholesale and cannot add a
 * field to an existing collection. There is no POST /fields path. Adding a
 * field to an already-created collection requires a POST /fields/<collection>
 * by hand, or a future extension to this script.
 */

import {
  PAGE_COLLECTIONS,
  PAGES_RELATIONS,
  PAGES_PERMISSIONS,
  PAGES_ASSET_FOLDER,
  pagesFilesPermission,
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

  // Static definitions only. The directus_files grant is built at runtime from
  // a folder id and targets a built-in collection, so it is deliberately not
  // checked here — it has no declared-field list to validate against.
  const known = new Set(PAGE_COLLECTIONS.map((c) => c.collection));
  for (const p of PAGES_PERMISSIONS) {
    if (!known.has(p.collection)) {
      problems.push(`permission on ${p.collection}: not defined in PAGE_COLLECTIONS`);
      continue;
    }
    // fields: ["*"] means "every field" and has nothing to check against a
    // declared list. A typo in an explicit list would otherwise silently
    // hide a field from the frontend, which is exactly the class of error
    // preflight exists to catch.
    if (Array.isArray(p.fields) && !(p.fields.length === 1 && p.fields[0] === "*")) {
      const declaredFields = declared.get(p.collection) ?? new Set();
      for (const f of p.fields) {
        if (!declaredFields.has(f)) {
          problems.push(`permission on ${p.collection}: fields lists "${f}", which is not a declared field on ${p.collection}`);
        }
      }
    }
  }

  // page_authors must be created before pages. At POST /collections time
  // pages.author is a plain integer column with no FK — the dependency only
  // materializes at POST /relations, which runs after both collections
  // exist — but the ordering invariant is still worth enforcing here so the
  // relation step never has to special-case creation order.
  const order = PAGE_COLLECTIONS.map((c) => c.collection);
  if (order.indexOf("page_authors") > order.indexOf("pages")) {
    problems.push("PAGE_COLLECTIONS order: page_authors must come before pages (pages.author references it)");
  }

  // Collection-level meta that references a field by name (archive_field,
  // sort_field) is a string with no schema-level validation on Directus's
  // side; a typo passes POST /collections and silently breaks the
  // archive/sort UI.
  for (const col of PAGE_COLLECTIONS) {
    const declaredFields = declared.get(col.collection) ?? new Set();
    for (const metaKey of ["archive_field", "sort_field"]) {
      const value = col.meta?.[metaKey];
      if (value != null && !declaredFields.has(value)) {
        problems.push(`${col.collection}.meta.${metaKey} references "${value}", which is not a declared field on ${col.collection}`);
      }
    }
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

// Used by --verify to compare nested field/permission definitions
// (meta.validation, etc.) without being tripped up by key-order differences
// between the local literal and whatever Directus's API returns.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((k, i) => k === bKeys[i] && deepEqual(a[k], b[k]));
}

// Order-insensitive comparison for `fields`/`special` string-array properties.
function sortedArraysEqual(a, b) {
  const as = JSON.stringify([...(a ?? [])].sort());
  const bs = JSON.stringify([...(b ?? [])].sort());
  return as === bs;
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

// The CMS asset folder and its file grant. Without this, /assets/<uuid>
// enforces read permission on the directus_files row and every inline page
// image and author avatar 403s for anonymous visitors.
const assetFolderId = await resolveAssetFolder(token);
const allPermissions = assetFolderId
  ? [...PAGES_PERMISSIONS, pagesFilesPermission(assetFolderId)]
  : PAGES_PERMISSIONS;

const livePerms = (await api(token, "GET", `/permissions?filter[policy][_eq]=${publicPolicy}&limit=-1`)).data ?? [];
for (const p of allPermissions) {
  const match = livePerms.find((lp) => lp.collection === p.collection && lp.action === p.action);
  if (!match) plan.permissions.push(`${p.collection}:${p.action} (create)`);
  else if (JSON.stringify(match.permissions ?? {}) !== JSON.stringify(p.permissions))
    plan.permissions.push(`${p.collection}:${p.action} (DRIFT — live filter ${JSON.stringify(match.permissions)}, expected ${JSON.stringify(p.permissions)})`);
}

/**
 * Find the CMS asset folder, creating it under --apply if absent.
 *
 * Returns null in dry run when the folder does not exist yet — the caller then
 * plans without the file grant and says so, rather than inventing an id.
 */
async function resolveAssetFolder(tok) {
  const q = `/folders?filter[name][_eq]=${encodeURIComponent(PAGES_ASSET_FOLDER)}&fields=id,name&limit=1`;
  const existing = ((await api(tok, "GET", q)).data ?? [])[0];
  if (existing) return existing.id;

  if (!APPLY) {
    console.log(`folder "${PAGES_ASSET_FOLDER}": absent — would create (file grant planned after it exists)`);
    return null;
  }
  console.log(`creating folder "${PAGES_ASSET_FOLDER}"`);
  return (await api(tok, "POST", "/folders", { name: PAGES_ASSET_FOLDER })).data.id;
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

if (VERIFY) {
  const drift = [];

  for (const col of PAGE_COLLECTIONS) {
    if (!(await exists(token, `/collections/${col.collection}`))) {
      drift.push(`collection ${col.collection}: MISSING`);
      continue;
    }
    // /fields/<collection> is admin-only, which is fine — we hold an admin token.
    const liveFieldRows = (await api(token, "GET", `/fields/${col.collection}`)).data ?? [];
    const liveFieldsByName = new Map(liveFieldRows.map((f) => [f.field, f]));
    for (const f of col.fields) {
      const live = liveFieldsByName.get(f.field);
      if (!live) {
        drift.push(`${col.collection}.${f.field}: MISSING`);
        continue;
      }

      if (f.type !== undefined && live.type !== f.type) {
        drift.push(`${col.collection}.${f.field}: type is ${JSON.stringify(live.type)}, expected ${JSON.stringify(f.type)}`);
      }

      // Directus omits is_unique entirely on the live row when it is false —
      // treat a missing/null live value as false rather than as drift.
      if (f.schema?.is_unique !== undefined) {
        const liveIsUnique = live.schema?.is_unique ?? false;
        if (liveIsUnique !== f.schema.is_unique) {
          drift.push(`${col.collection}.${f.field}: schema.is_unique is ${JSON.stringify(liveIsUnique)}, expected ${JSON.stringify(f.schema.is_unique)}`);
        }
      }

      if (f.meta?.validation !== undefined) {
        const liveValidation = live.meta?.validation ?? null;
        if (!deepEqual(liveValidation, f.meta.validation)) {
          drift.push(`${col.collection}.${f.field}: meta.validation is ${JSON.stringify(liveValidation)}, expected ${JSON.stringify(f.meta.validation)}`);
        }
      }

      if (f.meta?.special !== undefined) {
        const liveSpecial = live.meta?.special ?? [];
        if (!sortedArraysEqual(liveSpecial, f.meta.special)) {
          drift.push(`${col.collection}.${f.field}: meta.special is ${JSON.stringify([...liveSpecial].sort())}, expected ${JSON.stringify([...f.meta.special].sort())}`);
        }
      }
    }
  }

  for (const rel of PAGES_RELATIONS) {
    const key = relKey(rel.collection, rel.field);
    const live = liveRelations.find((r) => relKey(r.collection, r.field) === key);
    if (!live) drift.push(`relation ${key}: MISSING`);
    else if (live.related_collection !== rel.related_collection)
      drift.push(`relation ${key}: points at ${live.related_collection}, expected ${rel.related_collection}`);
  }

  for (const p of allPermissions) {
    const match = livePerms.find((lp) => lp.collection === p.collection && lp.action === p.action);
    if (!match) {
      drift.push(`permission ${p.collection}:${p.action}: MISSING`);
      continue;
    }
    if (JSON.stringify(match.permissions ?? {}) !== JSON.stringify(p.permissions))
      drift.push(`permission ${p.collection}:${p.action}: filter is ${JSON.stringify(match.permissions)}, expected ${JSON.stringify(p.permissions)}`);

    if (!sortedArraysEqual(match.fields, p.fields)) {
      drift.push(`permission ${p.collection}:${p.action}: fields is ${JSON.stringify([...(match.fields ?? [])].sort())}, expected ${JSON.stringify([...p.fields].sort())}`);
    }
  }

  if (drift.length) {
    console.error("\nVerify FAILED — live schema does not match the definitions:");
    for (const d of drift) console.error(`  - ${d}`);
    process.exit(1);
  }
  console.log("\nVerify OK — live schema matches the definitions");
  process.exit(0);
}

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

  for (const p of allPermissions) {
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
