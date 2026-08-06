# CMS Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the Directus `pages` and `page_authors` collections — WordPress-style CMS pages with WYSIWYG bodies, uploaded images, and allowlisted embeds — via an idempotent, dry-run-by-default provisioning script.

**Architecture:** Two files in `packages/backend/`, following the established `chat-collections.mjs` + `apply-chat-schema.mjs` split: a pure data module holding collection/field/relation/permission definitions, and a runner with three modes (dry run, `--apply`, `--verify`). All schema is created through the Directus HTTP API; nothing touches Postgres directly.

**Tech Stack:** Node 25 ESM (`.mjs`, no build step, no test harness — these scripts are run directly with `node`), Directus 12 REST API, Postgres 16 behind it.

## Global Constraints

- **Design doc:** `plans/2026-08-06-cms-pages-design.md`. Every decision there is binding.
- **No defaults for connection env.** `DIRECTUS_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` are required; the script exits non-zero if any is missing. A silent `localhost` fallback is how you target the wrong instance.
- **Dry run is the default.** Writes happen only under `--apply`.
- **Idempotent.** Existing collections, fields, relations, and permissions are detected and skipped, never recreated or silently overwritten.
- **Never import or run `seed.mjs`.** Its top-level module body bulk-imports media/mp3/news/pager fixtures into whatever database it is pointed at. Importing it *at all* executes those side effects.
- **Log response bodies on failure.** Directus schema errors are frequently opaque `400`s whose body is the only useful diagnostic.
- **Reserved slugs:** `assets`, `admin`, `api`.
- **Embed allowlist** (for the future renderer, recorded here so it is not re-derived): `www.youtube-nocookie.com` + `/embed/`, `www.youtube.com` + `/embed/`, `player.vimeo.com` + `/video/`, `archive.org` + `/embed/`.
- **Scope:** collections and provisioning only. The renderer (root-level slugs, static Classicy shell, `renderPageHtml.ts` sanitizer) is specced in the design doc and is a **separate future plan**. Do not build it here.

## File Structure

| File | Responsibility |
|---|---|
| `packages/backend/pages-collections.mjs` | **Create.** Pure data: `PAGE_COLLECTIONS`, `PAGES_RELATIONS`, `PAGES_PERMISSIONS`, `RESERVED_SLUGS`. No I/O, no side effects. |
| `packages/backend/apply-pages-schema.mjs` | **Create.** The runner: preflight self-check, login, dry-run planner, `--apply`, `--verify`. |
| `packages/backend/CLAUDE.md` | **Modify.** One line in the collections/seed area noting the new script and that it is not part of `seed.mjs`. |

The data/runner split mirrors `chat-collections.mjs` / `apply-chat-schema.mjs`, and exists for the same reason: schema definitions are read by humans reviewing a diff, while the runner is control flow. Keeping them apart means a field change shows up as a data diff.

## A note on testing

`packages/backend/` has **no `package.json` and no test harness** — the `.mjs` scripts are run directly with `node`, and nothing in the repo unit-tests them. This plan does not invent a harness for two files. Instead, verification is built into the script itself and is re-runnable:

- A **preflight self-check** runs in every mode and fails loudly on internal inconsistency (a relation naming a field that was never declared, a duplicate field, an empty reserved list). This catches the errors that would otherwise surface as opaque Directus `400`s.
- A **`--verify` mode** reads the live schema back and asserts it matches the definitions.

Steps below use these as the test cycle: run it, see it fail, fix, see it pass.

---

### Task 1: Schema definitions and the dry-run planner

**Files:**
- Create: `packages/backend/pages-collections.mjs`
- Create: `packages/backend/apply-pages-schema.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PAGE_COLLECTIONS: Array<{collection: string, meta: object, schema: object, fields: Array<object>}>` — ordered `page_authors` first, then `pages`. Order is load-bearing: `pages.author` is an M2O onto `page_authors`.
  - `PAGES_RELATIONS: Array<{collection: string, field: string, related_collection: string, meta: object, schema: object}>`
  - `PAGES_PERMISSIONS: Array<{collection: string, action: string, fields: string[], permissions: object}>`
  - `RESERVED_SLUGS: string[]`

- [ ] **Step 1: Create the schema definition module**

Create `packages/backend/pages-collections.mjs`:

```js
/**
 * pages-collections.mjs
 *
 * Schema definitions for the two CMS page collections (see
 * plans/2026-08-06-cms-pages-design.md). Pure data — no I/O, no side
 * effects — so this module can be imported by anything without
 * consequence. apply-pages-schema.mjs is the only consumer today.
 *
 * Deliberately NOT added to seed.mjs. That script bulk-imports historical
 * media/news/pager fixtures on import; these collections are authored
 * content and have no fixture data to load.
 */

// Root-level paths that nginx or Directus already answer. A page slugged
// with one of these would be created successfully and then be permanently
// unreachable, so Directus rejects them at save time via the `slug` field's
// validation filter below.
export const RESERVED_SLUGS = ["assets", "admin", "api"];

const STATUS_CHOICES = ["published", "draft", "archived"].map((v) => ({ text: v, value: v }));

export const PAGE_COLLECTIONS = [
  {
    collection: "page_authors",
    meta: {
      icon: "person",
      note: "Public byline records for CMS pages. Everything here is intended to be publicly readable.",
      display_template: "{{name}}",
    },
    schema: {},
    fields: [
      { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
      { field: "name", type: "string", schema: { is_nullable: false },
        meta: { interface: "input", width: "half", required: true } },
      { field: "email", type: "string", schema: { is_nullable: true },
        meta: { interface: "input", width: "half", note: "Rendered publicly as a mailto link. Expect it to be scraped." } },
      { field: "avatar", type: "uuid", schema: { is_nullable: true },
        meta: { interface: "file-image", special: ["file"], width: "half" } },
    ],
  },
  {
    collection: "pages",
    meta: {
      icon: "description",
      sort_field: "sort",
      note: "CMS pages (not blog posts). `parent` groups the nav menu; slugs stay flat and globally unique.",
      display_template: "{{title}}",
      archive_field: "status",
      archive_value: "archived",
      unarchive_value: "draft",
    },
    schema: {},
    fields: [
      { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
      { field: "status", type: "string", schema: { is_nullable: false, default_value: "draft" },
        meta: { interface: "select-dropdown", width: "half", options: { choices: STATUS_CHOICES } } },
      { field: "title", type: "string", schema: { is_nullable: false },
        meta: { interface: "input", width: "half", required: true } },
      // is_unique gives the DB-level guarantee; the validation filter is a
      // separate concern (reserved words, not collisions).
      { field: "slug", type: "string", schema: { is_nullable: false, is_unique: true },
        meta: {
          interface: "input", width: "half", required: true,
          options: { slug: true, trim: true },
          validation: { slug: { _nin: RESERVED_SLUGS } },
          validation_message: `Reserved path — pick another slug. Reserved: ${RESERVED_SLUGS.join(", ")}`,
          note: "Served at the site root, e.g. slug `about` → /about",
        } },
      { field: "parent", type: "integer", schema: { is_nullable: true },
        meta: { interface: "select-dropdown-m2o", width: "half", options: { template: "{{title}}" },
                note: "Groups this page under another in the nav menu. Does NOT affect the URL." } },
      { field: "author", type: "integer", schema: { is_nullable: true },
        meta: { interface: "select-dropdown-m2o", width: "half", options: { template: "{{name}}" } } },
      // options intentionally omitted -> Directus's default WYSIWYG toolbar,
      // which already carries the image, media (iframe embed), and source-code
      // buttons. Matches readme_articles.body, whose options are null.
      { field: "body", type: "text", schema: { is_nullable: true },
        meta: { interface: "input-rich-text-html", width: "full" } },
      { field: "show_in_nav", type: "boolean", schema: { is_nullable: false, default_value: true },
        meta: { interface: "boolean", width: "half", note: "Unchecked pages still resolve by URL, they just leave the menu." } },
      { field: "sort", type: "integer", schema: { is_nullable: true }, meta: { hidden: true } },
      { field: "date_created", type: "timestamp", schema: { is_nullable: true },
        meta: { special: ["date-created"], interface: "datetime", readonly: true, hidden: true, width: "half" } },
      { field: "date_updated", type: "timestamp", schema: { is_nullable: true },
        meta: { special: ["date-updated"], interface: "datetime", readonly: true, hidden: true, width: "half" } },
      { field: "user_created", type: "uuid", schema: { is_nullable: true },
        meta: { special: ["user-created"], interface: "select-dropdown-m2o", readonly: true, hidden: true, width: "half" } },
      { field: "user_updated", type: "uuid", schema: { is_nullable: true },
        meta: { special: ["user-updated"], interface: "select-dropdown-m2o", readonly: true, hidden: true, width: "half" } },
    ],
  },
];

// Directus does NOT infer relations from field naming — without these rows,
// `parent`/`author` render as bare number inputs and REST field expansion
// (`fields=author.name`) silently returns nothing.
export const PAGES_RELATIONS = [
  { collection: "pages", field: "parent", related_collection: "pages",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
  { collection: "pages", field: "author", related_collection: "page_authors",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
  { collection: "page_authors", field: "avatar", related_collection: "directus_files",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
  { collection: "pages", field: "user_created", related_collection: "directus_users",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
  { collection: "pages", field: "user_updated", related_collection: "directus_users",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
];

// fields: ["*"] on both — per-field permission limits are unverified on this
// instance and this design deliberately does not depend on them. Both
// collections are public-safe by construction; the one exposure is the
// user_created/user_updated UUIDs, which resolve to nobody without public
// read on directus_users (which does not exist and must not be added).
export const PAGES_PERMISSIONS = [
  { collection: "pages", action: "read", fields: ["*"], permissions: { status: { _eq: "published" } } },
  { collection: "page_authors", action: "read", fields: ["*"], permissions: {} },
];
```

- [ ] **Step 2: Create the runner with preflight and dry run**

Create `packages/backend/apply-pages-schema.mjs`:

```js
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

if (!APPLY && !VERIFY) {
  console.log("\ndry run complete — re-run with --apply to change anything");
}
```

- [ ] **Step 3: Run the preflight against a deliberately broken definition to prove it catches errors**

Temporarily add a bogus relation to `pages-collections.mjs`:

```js
  { collection: "pages", field: "nonexistent_field", related_collection: "page_authors",
    meta: { sort_field: null }, schema: { on_delete: "SET NULL" } },
```

Run: `node packages/backend/apply-pages-schema.mjs`

Expected: exits `1` before any network call, printing:
```
Preflight failed — the definitions are internally inconsistent:
  - relation pages.nonexistent_field: no such field declared
```

If it does **not** fail, the preflight is not wired up — fix it before continuing. This step exists because a preflight that never fires is worse than none: it produces false confidence.

- [ ] **Step 4: Remove the bogus relation and confirm a clean dry run**

Delete the bogus relation line added in Step 3.

Run (from the repo root, with credentials exported):
```bash
DIRECTUS_URL=https://api.911realtime.org \
ADMIN_EMAIL=<admin email> \
ADMIN_PASSWORD=<admin password> \
node packages/backend/apply-pages-schema.mjs
```

Expected output:
```
preflight ok — 2 collection(s), 5 relation(s), 2 permission(s)
target: https://api.911realtime.org

Plan:
  collections to create: page_authors, pages
  relations to create:   pages.parent, pages.author, page_authors.avatar, pages.user_created, pages.user_updated
  permissions:           pages:read (create), page_authors:read (create)
  public policy id:      abf8a154-5b1c-4a46-ac9c-7300570f4f17

dry run complete — re-run with --apply to change anything
```

`abf8a154-5b1c-4a46-ac9c-7300570f4f17` is Directus's well-known static
public-policy UUID, so seeing it confirms discovery found the right row. It is
deliberately **not** hardcoded — the discovery logic stays, and the
`found.length !== 1` guard dumps every policy if the shape changes again. A grant
written to the wrong policy is this script's worst failure mode: it would either
silently do nothing or expose data to the wrong audience.

Confirm no writes occurred: `curl -s -o /dev/null -w "%{http_code}\n" https://api.911realtime.org/items/pages` still returns `403`.

- [ ] **Step 5: Verify the missing-env guard**

Run: `node packages/backend/apply-pages-schema.mjs` with no env set.

Expected: exit `1`, message `Missing required environment variable: DIRECTUS_URL` plus the "refusing to fall back" explanation. No network call.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/pages-collections.mjs packages/backend/apply-pages-schema.mjs
git commit -m "feat(pages): add CMS pages schema definitions and dry-run planner"
```

---

### Task 2: Apply mode

**Files:**
- Modify: `packages/backend/apply-pages-schema.mjs`

**Interfaces:**
- Consumes: `PAGE_COLLECTIONS`, `PAGES_RELATIONS`, `PAGES_PERMISSIONS`, the `plan` object and `api`/`findPublicPolicy` helpers from Task 1.
- Produces: an `--apply` mode. No new exports.

- [ ] **Step 1: Add the apply block**

In `apply-pages-schema.mjs`, replace the final `if (!APPLY && !VERIFY)` block with:

```js
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
```

- [ ] **Step 2: Confirm the dry run is still clean and still writes nothing**

Run the same dry-run command from Task 1 Step 4.

Expected: identical output to Task 1 Step 4. The apply block must not execute. `curl` on `/items/pages` still returns `403`.

This is the check that matters most here — an `--apply` block that runs unconditionally is the single most damaging bug this script could have, and it is invisible if you only ever test with `--apply`.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/apply-pages-schema.mjs
git commit -m "feat(pages): add --apply mode to the pages schema script"
```

---

### Task 3: Verify mode

**Files:**
- Modify: `packages/backend/apply-pages-schema.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: a `--verify` mode that exits `0` when the live schema matches the definitions and `1` on any drift.

- [ ] **Step 1: Add the verify block**

Insert before the `if (APPLY)` block:

```js
if (VERIFY) {
  const drift = [];

  for (const col of PAGE_COLLECTIONS) {
    if (!(await exists(token, `/collections/${col.collection}`))) {
      drift.push(`collection ${col.collection}: MISSING`);
      continue;
    }
    // /fields/<collection> is admin-only, which is fine — we hold an admin token.
    const liveFields = new Set(((await api(token, "GET", `/fields/${col.collection}`)).data ?? []).map((f) => f.field));
    for (const f of col.fields) {
      if (!liveFields.has(f.field)) drift.push(`${col.collection}.${f.field}: MISSING`);
    }
  }

  for (const rel of PAGES_RELATIONS) {
    const key = relKey(rel.collection, rel.field);
    const live = liveRelations.find((r) => relKey(r.collection, r.field) === key);
    if (!live) drift.push(`relation ${key}: MISSING`);
    else if (live.related_collection !== rel.related_collection)
      drift.push(`relation ${key}: points at ${live.related_collection}, expected ${rel.related_collection}`);
  }

  for (const p of PAGES_PERMISSIONS) {
    const match = livePerms.find((lp) => lp.collection === p.collection && lp.action === p.action);
    if (!match) drift.push(`permission ${p.collection}:${p.action}: MISSING`);
    else if (JSON.stringify(match.permissions ?? {}) !== JSON.stringify(p.permissions))
      drift.push(`permission ${p.collection}:${p.action}: filter is ${JSON.stringify(match.permissions)}, expected ${JSON.stringify(p.permissions)}`);
  }

  if (drift.length) {
    console.error("\nVerify FAILED — live schema does not match the definitions:");
    for (const d of drift) console.error(`  - ${d}`);
    process.exit(1);
  }
  console.log("\nVerify OK — live schema matches the definitions");
  process.exit(0);
}
```

- [ ] **Step 2: Run verify before anything has been applied, to prove it reports failure**

Run: the dry-run command from Task 1 Step 4, with `--verify` appended.

Expected: exit `1`, listing every collection, relation, and permission as `MISSING`.

A verifier that passes against an empty database is worthless; this step proves it does not.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/apply-pages-schema.mjs
git commit -m "feat(pages): add --verify mode to the pages schema script"
```

---

### Task 4: Apply to production and confirm public read

**Files:** none modified. This task runs the script against the live instance.

**Interfaces:**
- Consumes: the finished script from Tasks 1–3.
- Produces: live `pages` and `page_authors` collections, one seeded author and one seeded page.

- [ ] **Step 1: Check the database is quiet before touching schema**

```bash
kubectl exec -n rt911 deploy/rt911-db -- \
  sh -c 'psql -U directus -d directus -c "select pid, state, wait_event_type, now() - query_start as runtime, left(query, 60) as query from pg_stat_activity where state <> '"'"'idle'"'"' order by query_start;"'
```

Expected: a small number of short-running rows. **Stop and wait** if you see a long-running `COPY`, `pg_dump`, or anything running for more than a few seconds.

This is not ceremony. A Directus field-add `ALTER` previously queued behind a running `pg_dump` in this project and stalled live reads for roughly two minutes. The nightly backup CronJob is the collision to avoid.

- [ ] **Step 2: Dry run against production one more time**

Run the dry-run command from Task 1 Step 4. Read the plan. Confirm it lists exactly the two collections, five relations, and two permissions — nothing unexpected.

- [ ] **Step 3: Apply**

Same command with `--apply` appended.

Expected: `creating collection page_authors`, `creating collection pages`, five `creating relation` lines, two `granting public read` lines, then `apply complete`.

If any step throws, the error message contains the Directus response body. Do not retry blindly — read it. A partially-created schema is safe to re-run against, because every step is existence-checked.

- [ ] **Step 4: Verify**

Same command with `--verify` appended.

Expected: `Verify OK — live schema matches the definitions`, exit `0`.

- [ ] **Step 5: Seed one author and one page**

```bash
export DHOST=https://api.911realtime.org
export DTOKEN=$(curl -sS -X POST "$DHOST/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["access_token"])')

curl -sS -X POST "$DHOST/items/page_authors" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "911 Realtime", "email": "info@911realtime.org" }' | head -c 300; echo

curl -sS -X POST "$DHOST/items/pages" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{
    "title": "About",
    "slug": "about",
    "status": "published",
    "author": 1,
    "show_in_nav": true,
    "body": "<p>Placeholder. Replace this from the Directus editor.</p>"
  }' | head -c 300; echo
```

- [ ] **Step 6: Confirm the reserved-slug validation actually rejects**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$DHOST/items/pages" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{ "title": "Bad", "slug": "admin", "status": "draft" }'
```

Expected: `400`. If this returns `200`, the `validation` filter did not take effect — delete the created row, then fix the field's meta via `PATCH /fields/pages/slug` before continuing.

- [ ] **Step 7: Confirm anonymous public read works and respects the status filter**

```bash
# Published page is visible anonymously, with the author expanded.
curl -sS "$DHOST/items/pages?fields=id,title,slug,author.name,author.email&filter[slug][_eq]=about" | head -c 400; echo

# A draft must NOT appear.
curl -sS -X POST "$DHOST/items/pages" -H "Authorization: Bearer $DTOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Draft Only", "slug": "draft-only", "status": "draft" }' > /dev/null
curl -sS "$DHOST/items/pages?filter[slug][_eq]=draft-only" | head -c 200; echo
```

Expected: the first returns the About page **with `author.name` populated** — that is the proof the relation was created correctly, since field expansion silently returns nothing without it. The second returns `{"data":[]}`.

Clean up: delete the `draft-only` row.

- [ ] **Step 8: Note the script in the backend guidance**

In `packages/backend/CLAUDE.md`, near the existing discussion of `seed.mjs` and collections, add:

```markdown
- **`apply-pages-schema.mjs`** provisions the `pages` / `page_authors` CMS collections
  (see `plans/2026-08-06-cms-pages-design.md`). Dry run by default, `--apply` to
  commit, `--verify` to assert the live schema still matches. Like the `chat_*`
  script it is deliberately independent of `seed.mjs`.
```

- [ ] **Step 9: Commit**

```bash
git add packages/backend/CLAUDE.md
git commit -m "docs(backend): note the pages schema provisioning script"
```

---

## Self-Review

**Spec coverage.** Walking the design doc section by section:

| Design section | Covered by |
|---|---|
| `page_authors` collection | Task 1 Step 1 |
| `pages` collection, all fields | Task 1 Step 1 |
| Globally unique slug | Task 1 Step 1 (`is_unique: true`) |
| Reserved-slug validation | Task 1 Step 1 (`meta.validation`), proven in Task 4 Step 6 |
| Permissions, `fields: ["*"]` | Task 1 Step 1, applied Task 4 Step 3, proven Task 4 Step 7 |
| Relations (M2O, self-ref, file, users) | Task 1 Step 1, applied Task 4 Step 3, proven Task 4 Step 7 |
| WYSIWYG with `options` omitted | Task 1 Step 1 |
| Idempotency | Task 2 Step 1 (existence checks on every loop) |
| Dry run by default | Task 1 Step 2, guarded in Task 2 Step 2 |
| No-defaults env guard | Task 1 Step 2, proven Task 1 Step 5 |
| `pg_stat_activity` preflight | Task 4 Step 1 |
| No schema-op bursts | Task 2 Step 1 (sequential `for` loops, no `Promise.all`) |
| Response bodies logged on failure | Task 1 Step 2 (`api()` includes body in the thrown message) |
| Never touch `seed.mjs` | Stated in Global Constraints and both file headers |
| Seed a page so the renderer isn't built against nothing | Task 4 Step 5 |
| Renderer, sanitizer, routing | **Deliberately out of scope** — separate future plan, per the design doc |

No gaps.

**Placeholder scan.** No `TBD`/`TODO`/"add error handling"/"similar to Task N". `<admin email>` and `<admin password>` in shell commands are operator-supplied credentials, not unwritten content.

**Type consistency.** `relKey(collection, field)` is defined once in Task 1 and reused unchanged in Tasks 2 and 3. `plan.collections` / `plan.relations` / `plan.permissions` hold strings throughout. `findPublicPolicy` returns a policy id string, used as `policy:` in the permission POST. `livePerms` and `liveRelations` are computed in Task 1 and read in Tasks 2 and 3 — both are module-scope `const`s, so they remain in scope.

One real hazard worth flagging to the implementer: `findPublicPolicy` is declared with `function` and therefore hoists, so calling it above its definition works. If anyone converts it to a `const` arrow function, the call site above it breaks with a temporal-dead-zone error. Keep it a function declaration or move it up.
