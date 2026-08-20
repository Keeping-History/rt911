/**
 * apply-chat-user-fields.mjs
 *
 * Creates the chat_user_fields collection (if absent) and seeds the nine rows
 * the feature ships with. Idempotent: an existing collection is left alone,
 * and a row whose `field` already exists is not duplicated.
 *
 * Separate from apply-chat-schema.mjs because that script's job is the nine
 * original chat_* collections; this one also seeds DATA, which that script
 * deliberately never does.
 *
 * Usage:
 *   node apply-chat-user-fields.mjs            # dry run (default) -- prints
 *                                              # the plan, issues only reads
 *   node apply-chat-user-fields.mjs --apply    # creates + seeds
 *
 * Required env (no defaults, on purpose -- a silent localhost default is how
 * you accidentally target the wrong Directus instance):
 *   DIRECTUS_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 */

import { CHAT_COLLECTIONS } from "./chat-collections.mjs";

const APPLY = process.argv.includes("--apply");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const DIRECTUS_URL = requireEnv("DIRECTUS_URL");
const ADMIN_EMAIL = requireEnv("ADMIN_EMAIL");
const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");

// The shipped default exposure set. Ordered as the prompt renders them.
const SEED_ROWS = [
  { field: "first_name", label: "first name", sort: 1 },
  { field: "last_name", label: "last name", sort: 2 },
  { field: "city", label: "city", sort: 3 },
  { field: "state", label: "state", sort: 4 },
  { field: "country", label: "country", sort: 5 },
  { field: "school_name", label: "school", sort: 6 },
  { field: "educator_role", label: "role", sort: 7 },
  { field: "grade_levels", label: "grade levels", sort: 8 },
  { field: "subjects", label: "subjects", sort: 9 },
];

async function login() {
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return (await res.json()).data.access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : await res.json();
}

const spec = CHAT_COLLECTIONS.find((c) => c.collection === "chat_user_fields");
if (!spec) {
  console.error("chat_user_fields is missing from CHAT_COLLECTIONS in chat-collections.mjs");
  process.exit(1);
}

const token = await login();

let exists = true;
try {
  await api(token, "GET", "/collections/chat_user_fields");
} catch {
  exists = false;
}

if (exists) {
  console.log("collection chat_user_fields: already present");
} else {
  console.log(`${APPLY ? "Creating" : "Would create"} collection chat_user_fields`);
  if (APPLY) await api(token, "POST", "/collections", spec);
}

const present = exists
  ? new Set(
      ((await api(token, "GET", "/items/chat_user_fields?fields=field&limit=-1")).data ?? []).map(
        (r) => r.field,
      ),
    )
  : new Set();

const missing = SEED_ROWS.filter((r) => !present.has(r.field));
if (missing.length === 0) {
  console.log("seed rows: all present");
} else {
  console.log(
    `${APPLY ? "Seeding" : "Would seed"} ${missing.length} row(s): ${missing.map((r) => r.field).join(", ")}`,
  );
  if (APPLY) {
    await api(token, "POST", "/items/chat_user_fields", missing.map((r) => ({ ...r, active: 1 })));
  }
}

console.log(APPLY ? "done" : "dry run complete -- re-run with --apply to change anything");
