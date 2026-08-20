#!/usr/bin/env node
/**
 * Add `username` to directus_users, let a user edit their own, and backfill one
 * for everybody who does not have one.
 *
 * This is the name a chat buddy calls the student. Before it existed the
 * composer borrowed first_name, and before that it had nothing at all -- which
 * is how Carol, whose persona says "You are Danny's aunt", ended up greeting
 * every student as Danny.
 *
 * Derivation order, matching the product decision:
 *   1. the part of the email before the @
 *   2. first name + last name
 *   3. a random name, so a user with neither still gets something stable
 *
 * Uniqueness is enforced in the database and collisions are resolved by
 * appending a number, because two students sharing a screen name in the same
 * classroom would be genuinely confusing.
 *
 * Directus permissions are FIELD-SCOPED here: directus_users grants name each
 * readable and updatable column explicitly, so a new field is invisible to the
 * Account app until it is added to both lists. That is the step that is easy to
 * miss -- the field exists, the API accepts nothing, and nothing says why.
 *
 * Dry run by default; pass --apply to write.
 */

const APPLY = process.argv.includes("--apply");

const DIRECTUS_URL = required("DIRECTUS_URL");
const ADMIN_EMAIL = required("ADMIN_EMAIL");
const ADMIN_PASSWORD = required("ADMIN_PASSWORD");

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return v;
}

const FIELD = {
  collection: "directus_users",
  field: "username",
  type: "string",
  meta: {
    interface: "input",
    note: "The screen name buddies use in IM Buddies chat. Lowercase letters, numbers, underscore.",
    options: { placeholder: "e.g. skaterboi1988" },
  },
  schema: { is_nullable: true, is_unique: true },
};

// Keep it to what a 2001 screen name could hold, and lowercase so two users
// cannot differ only by case.
function sanitize(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 24);
}

function randomName() {
  // Only reached by a user with no email and no name at all. Deliberately
  // obvious as a placeholder so its owner wants to change it.
  const n = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `guest${n}`;
}

function derive(user) {
  const fromEmail = sanitize((user.email || "").split("@")[0]);
  if (fromEmail) return { name: fromEmail, how: "email" };

  const fromName = sanitize(`${user.first_name || ""}${user.last_name || ""}`);
  if (fromName) return { name: fromName, how: "name" };

  return { name: randomName(), how: "random" };
}

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

// --- 1. the field ---
let fieldExists = true;
try {
  await api(token, "GET", `/fields/directus_users/username`);
} catch {
  fieldExists = false;
}
if (fieldExists) {
  console.log("field directus_users.username: already present");
} else {
  console.log(`${APPLY ? "Creating" : "Would create"} field directus_users.username`);
  if (APPLY) await api(token, "POST", "/fields/directus_users", FIELD);
}

// --- 2. permissions: field-scoped, so the new column must be named ---
const perms = (
  await api(token, "GET", "/permissions?filter[collection][_eq]=directus_users&fields=id,action,fields&limit=-1")
).data;

let permsPatched = 0;
for (const p of perms) {
  if (!["read", "update"].includes(p.action)) continue;
  // Directus synthesizes some permission rows that have no id and cannot be
  // patched; only the stored ones are ours to change.
  if (p.id == null) continue;
  const fields = p.fields || [];
  if (fields.includes("*") || fields.includes("username")) {
    console.log(`permission ${p.action}: username already granted`);
    continue;
  }
  console.log(`${APPLY ? "Granting" : "Would grant"} username on the ${p.action} permission`);
  if (APPLY) await api(token, "PATCH", `/permissions/${p.id}`, { fields: [...fields, "username"] });
  permsPatched++;
}

// --- 3. backfill ---
let users = [];
try {
  users = (await api(token, "GET", "/users?fields=id,email,first_name,last_name,username&limit=-1")).data;
} catch (err) {
  if (!fieldExists && !APPLY) {
    console.log("\n(dry run) username column does not exist yet, so the backfill cannot be previewed.");
    console.log("Re-run with --apply to create the field, grant it, and backfill in one pass.");
    process.exit(0);
  }
  throw err;
}

// Seed the taken set from names already in use so the backfill cannot collide
// with a user who set one by hand.
const taken = new Set(users.map((u) => u.username).filter(Boolean));
let assigned = 0;
const byHow = { email: 0, name: 0, random: 0 };

for (const u of users) {
  if (u.username) continue;

  const { name, how } = derive(u);
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}${n}`;
  taken.add(candidate);

  console.log(`${APPLY ? "Assigning" : "Would assign"} ${candidate}  (from ${how})`);
  if (APPLY) await api(token, "PATCH", `/users/${u.id}`, { username: candidate });
  assigned++;
  byHow[how]++;
}

console.log("\n--- Summary ---");
console.log(`Permissions ${APPLY ? "patched" : "to patch"}: ${permsPatched}`);
console.log(`Usernames ${APPLY ? "assigned" : "to assign"}: ${assigned}`);
console.log(`  from email: ${byHow.email}   from name: ${byHow.name}   random: ${byHow.random}`);
console.log(`Already had one: ${users.filter((u) => u.username).length}`);
if (APPLY) console.log("\nThe streamer reads this per connection — no restart needed.");
