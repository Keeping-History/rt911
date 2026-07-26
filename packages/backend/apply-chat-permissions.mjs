/**
 * apply-chat-permissions.mjs
 *
 * Grants the Directus permissions the IM Buddies chat_* collections need,
 * and nothing else. This is the step that turns "chat_messages/chat_blocks
 * are per-user" from a comment in chat-collections.mjs into an enforced
 * policy -- see verify-chat-isolation.mjs for the proof that it actually
 * holds.
 *
 * Grants (all on the "Teacher" policy -- the one reusable "any signed-in
 * user" policy in this project; see scripts/playlist-auth/apply.sh and the
 * tm_bookmarks_personal precedent):
 *
 *   chat_messages   create + read, both scoped to {"user": {"_eq": "$CURRENT_USER"}}
 *   chat_blocks     read only, same filter -- blocks are teacher/system-
 *                   imposed, so a student never creates, updates, or deletes
 *                   their own block row
 *
 * chat_messages/chat_blocks key off a plain `user` uuid column, not the
 * auto-stamped `user_created` special other per-user collections in this
 * project use. `permissions` (the filter Directus checks against an
 * *existing* row) has no effect on create -- there is no row yet -- so the
 * create grant additionally sets `validation` (reject a payload whose user
 * isn't the caller) and `presets` (auto-fill it for a well-behaved client).
 *
 * Public read (on the $t:public_label policy) for the reference collections
 * that carry no per-user data: chat_profiles, chat_beacons, chat_phases,
 * chat_schedules, chat_knowledge.
 *
 * chat_settings gets NO grant, for any policy, in either direction. It holds
 * no credentials (those are env-only) but it is live operational
 * configuration -- model/token/temperature knobs with a direct dollar cost
 * per request -- so it stays admin-only. This script actively checks for and
 * refuses to proceed past an existing non-admin grant on chat_settings
 * rather than silently leaving one in place.
 *
 * Drift detection: an existing permission row for one of the grants above is
 * NOT treated as "already granted" unless its fields/permissions/validation/
 * presets structurally match what's expected. A grant that exists but is
 * unfiltered -- the exact misconfiguration this task exists to prevent -- is
 * reported as drift, not silently skipped: the dry run lists it under "Would
 * fix" and exits 1, and --apply PATCHes it back to the correct filter rather
 * than leaving it alone.
 *
 * Usage:
 *   node apply-chat-permissions.mjs            # dry run (default) -- prints
 *                                               # the plan, makes no writes,
 *                                               # issues only read requests;
 *                                               # exits 1 if drift is found
 *   node apply-chat-permissions.mjs --apply    # creates missing permission
 *                                               # rows and corrects drifted
 *                                               # ones
 *
 * Required env (no defaults, on purpose -- a silent default is how you
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

// Same ~12-line api() wrapper apply-chat-schema.mjs and seed.mjs use,
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
// exists but is unfiltered -- exactly the misconfiguration this whole task
// exists to prevent -- must never be reported as "already granted." These
// helpers compare an existing /permissions row against the one this script
// expects, independent of key order (Directus does not guarantee the order
// it returns JSON object keys in) and independent of Directus normalizing an
// absent filter to `{}` on some routes and `null` on others -- both mean "no
// restriction" and must compare equal to each other, not just to themselves.

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
// the grant this script wants in place. Every field this script ever sets
// is checked, not just `permissions` -- a drifted `fields` (e.g. narrowed
// off the wildcard) or a stale `presets`/`validation` is exactly as much a
// drift as the ownership filter itself, and this is the one function that
// decides whether re-running this script on a misconfigured instance stays
// silent or speaks up.
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

const OWN_FILTER = { user: { _eq: "$CURRENT_USER" } };

const TEACHER_GRANTS = [
  { collection: "chat_messages", action: "create", fields: ["*"], validation: OWN_FILTER, presets: { user: "$CURRENT_USER" } },
  { collection: "chat_messages", action: "read", fields: ["*"], permissions: OWN_FILTER },
  { collection: "chat_blocks", action: "read", fields: ["*"], permissions: OWN_FILTER },
];

const PUBLIC_READ_COLLECTIONS = ["chat_profiles", "chat_beacons", "chat_phases", "chat_schedules", "chat_knowledge"];

const ADMIN_ONLY_COLLECTIONS = ["chat_settings"];

console.log(APPLY ? "Applying IM Buddies chat_* permissions…" : "DRY RUN — no changes will be made (pass --apply to apply).");
console.log(`Target: ${DIRECTUS_URL}`);

const token = await login();
console.log("Authenticated.");

const teacherPolicy = await findPolicyByName(token, "Teacher");
if (!teacherPolicy) {
  console.error('Teacher policy not found (GET /policies?filter[name][_eq]=Teacher returned no rows).');
  console.error("This script scopes chat_messages/chat_blocks to that policy by name and refuses to guess a different one — create it first.");
  process.exit(1);
}

const publicPolicy = await findPolicyByName(token, "$t:public_label");
if (!publicPolicy) {
  console.error("Public policy ($t:public_label) not found — cannot grant public read on the chat_* reference collections.");
  process.exit(1);
}

console.log(`Teacher policy: ${teacherPolicy.id}`);
console.log(`Public policy:  ${publicPolicy.id}`);

// One fetch covers every existing grant this script cares about, so the
// per-collection checks below are pure in-memory lookups rather than a
// GET per candidate grant.
const existingOnRelevantPolicies = await api(
  token,
  "GET",
  `/permissions?filter[policy][_in]=${teacherPolicy.id},${publicPolicy.id}&limit=-1`,
);

function findExistingGrant(policyId, collection, action) {
  return existingOnRelevantPolicies.data.find((p) => p.policy === policyId && p.collection === collection && p.action === action) ?? null;
}

// chat_settings check runs before anything else is planned: applying new
// grants elsewhere while a known hole sits on chat_settings would be
// irresponsible. This checks every policy's grants on chat_settings, not
// just Teacher/public, since admin_access is what actually matters.
const allChatSettingsPerms = await api(token, "GET", `/permissions?filter[collection][_eq]=chat_settings&limit=-1`);
if (allChatSettingsPerms.data.length > 0) {
  const allPolicies = await api(token, "GET", "/policies?fields=id,name,admin_access&limit=-1");
  const policyById = new Map(allPolicies.data.map((p) => [p.id, p]));
  const violations = allChatSettingsPerms.data.filter((p) => {
    const policy = policyById.get(p.policy);
    return !policy || !policy.admin_access;
  });
  if (violations.length > 0) {
    console.error("\n*** chat_settings has a non-admin permission grant. This must be removed by hand before this script proceeds. ***");
    for (const v of violations) {
      const policy = policyById.get(v.policy);
      console.error(`  permission id=${v.id} action=${v.action} policy=${v.policy} (${policy?.name ?? "unknown policy"})`);
    }
    process.exit(1);
  }
}

const toCreate = [];
const toSkip = [];
const toFix = [];

function plan(policyId, policyLabel, grant) {
  const expected = expectedGrantBody(grant);
  const entry = { policyId, policyLabel, ...grant };
  const existingRow = findExistingGrant(policyId, grant.collection, grant.action);
  if (!existingRow) {
    toCreate.push(entry);
  } else if (grantMatches(existingRow, expected)) {
    toSkip.push(entry);
  } else {
    toFix.push({ ...entry, permissionId: existingRow.id, existingRow, expected });
  }
}

for (const grant of TEACHER_GRANTS) plan(teacherPolicy.id, "Teacher", grant);
for (const collection of PUBLIC_READ_COLLECTIONS) plan(publicPolicy.id, "Public", { collection, action: "read", fields: ["*"] });

function describe(entry) {
  return `${entry.policyLabel} policy — ${entry.collection}.${entry.action}`;
}

console.log("\nAdmin-only, no grant will be created for any policy:");
for (const collection of ADMIN_ONLY_COLLECTIONS) console.log(`  - ${collection}`);

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
  const body = { policy: entry.policyId, collection: entry.collection, action: entry.action, ...expectedGrantBody(entry) };
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
console.log(`Admin-only, untouched: ${ADMIN_ONLY_COLLECTIONS.join(", ")}`);
