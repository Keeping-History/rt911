#!/usr/bin/env node
/**
 * Add chat_profiles.profile_text: student-facing prose for the Get Info
 * window, distinct from `persona` (a second-person instruction to the model).
 * An empty profile_text is a curation gap a curator can fix; showing persona
 * instead would leak the mechanism, so the field is nullable and there is no
 * fallback -- see internal/chat/profile.go's Roster.
 *
 * Dry run by default; pass --apply to write. Idempotent: does nothing if the
 * field already exists.
 *
 * Not to be confused with seed.mjs, which also bulk-imports media, news and
 * pager data and must never be pointed at a live instance to add a collection.
 */

const APPLY = process.argv.includes("--apply");

const DIRECTUS_URL = required("DIRECTUS_URL");
const ADMIN_EMAIL = required("ADMIN_EMAIL");
const ADMIN_PASSWORD = required("ADMIN_PASSWORD");

function required(name) {
  const v = process.env[name];
  if (!v) {
    // No localhost default on purpose: a silent fallback is how you configure
    // the wrong instance without noticing.
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return v;
}

const FIELD = {
  collection: "chat_profiles",
  field: "profile_text",
  type: "text",
  meta: {
    interface: "input-multiline",
    note: "What a student sees in Get Info. Write it as the buddy would describe themselves — NOT the persona, which is an instruction to the model.",
  },
  schema: { is_nullable: true },
};

async function login() {
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /auth/login → ${res.status}: ${text}`);
  return JSON.parse(text).data.access_token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

if (!APPLY) console.log("DRY RUN — no changes will be made (pass --apply to apply).");
console.log(`Target: ${DIRECTUS_URL}\n`);
const token = await login();

let exists = true;
try {
  await api(token, "GET", `/fields/${FIELD.collection}/${FIELD.field}`);
} catch {
  exists = false;
}

if (exists) {
  console.log(`field ${FIELD.collection}.${FIELD.field}: already present`);
} else {
  console.log(`${APPLY ? "Creating" : "Would create"} field ${FIELD.collection}.${FIELD.field}`);
  if (APPLY) await api(token, "POST", `/fields/${FIELD.collection}`, FIELD);
}

console.log("\n--- Summary ---");
console.log(`Field ${APPLY ? "created" : "to create"}: ${exists ? 0 : 1}`);
if (!APPLY) console.log("\nDry run complete. Re-run with --apply to write.");
