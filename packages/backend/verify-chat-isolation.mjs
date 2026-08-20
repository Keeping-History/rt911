/**
 * verify-chat-isolation.mjs
 *
 * The proof, not the assertion: two real Directus accounts, a real inserted
 * row, and a real cross-account read against production. apply-chat-
 * permissions.mjs configures the policy; this script is what catches a
 * misconfiguration that would otherwise leak one student's conversation with
 * an AI character to another student.
 *
 * What it does, against whatever DIRECTUS_URL points at:
 *   1. Logs in as account A, inserts a chat_messages row, records its id.
 *   2. Logs in as account B, GETs that row by id.
 *   3. Asserts B receives zero rows. A non-empty result exits 1 immediately
 *      -- that is a live privacy incident, not a bug to file.
 *   4. Asserts B's PATCH and DELETE of that row both come back 401/403 --
 *      not merely "not ok," since a 5xx or a network failure proves nothing
 *      about the permission model and must fail loudly instead.
 *   5. Repeats 1-4 for chat_blocks (seeded by the admin account, since the
 *      Teacher policy intentionally grants no create/update/delete on
 *      chat_blocks to anyone -- see apply-chat-permissions.mjs).
 *   6. Cleans up both probe rows using the admin account, since neither
 *      collection grants delete to the Teacher policy either: chat_messages
 *      is a conversation log (no user-facing delete, by design) and
 *      chat_blocks is admin/teacher-managed (no user-facing create or
 *      delete). Account A's own credentials cannot remove what it just
 *      inserted -- that is the isolation model working as intended, not a
 *      script bug.
 *
 * Every assertion is real: if login fails, if either insert fails, or if any
 * required credential is missing, this exits non-zero with a specific
 * message. It never skips a check and reports success -- a verification
 * script that can pass without actually testing anything is worse than none.
 *
 * Required env (no defaults, on purpose):
 *   DIRECTUS_URL                              target instance
 *   ADMIN_EMAIL, ADMIN_PASSWORD               used only to seed/clean up the
 *                                              chat_blocks probe and to clean
 *                                              up the chat_messages probe --
 *                                              never to perform the A/B
 *                                              isolation check itself
 *   CHAT_VERIFY_A_EMAIL, CHAT_VERIFY_A_PASSWORD   account A (the "owner")
 *   CHAT_VERIFY_B_EMAIL, CHAT_VERIFY_B_PASSWORD   account B (the "attacker")
 *
 * A and B must be distinct, real, non-admin accounts on the Teacher policy.
 *
 * Usage:
 *   node verify-chat-isolation.mjs
 *
 * Exit code 0 means every assertion passed. Anything else means stop and fix
 * the policy before doing anything else with this database.
 */

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    console.error("Refusing to run with a partial credential set — an isolation check that silently skips a login is not a check.");
    process.exit(1);
  }
  return value;
}

const DIRECTUS_URL = requireEnv("DIRECTUS_URL");
const ADMIN_EMAIL = requireEnv("ADMIN_EMAIL");
const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");
const A_EMAIL = requireEnv("CHAT_VERIFY_A_EMAIL");
const A_PASSWORD = requireEnv("CHAT_VERIFY_A_PASSWORD");
const B_EMAIL = requireEnv("CHAT_VERIFY_B_EMAIL");
const B_PASSWORD = requireEnv("CHAT_VERIFY_B_PASSWORD");

if (A_EMAIL === B_EMAIL) {
  console.error("CHAT_VERIFY_A_EMAIL and CHAT_VERIFY_B_EMAIL are the same account — this script proves nothing about cross-account isolation unless they differ.");
  process.exit(1);
}

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

let assertionCount = 0;
function check(condition, description) {
  assertionCount++;
  if (!condition) fail(`assertion failed: ${description}`);
  console.log(`  ok - ${description}`);
}

// `!res.ok` is not proof of a permission denial -- a 500 from an unrelated
// bug, a network hiccup, or a typo'd path would all print the same
// reassuring "cannot" line as a real 403. Only 401 (bad/expired token) and
// 403 (FORBIDDEN, the actual denial code) count. 404 is deliberately NOT
// accepted here: per current Directus docs (Errors > HTTP Status Codes),
// Directus returns FORBIDDEN instead of 404 Not Found specifically to avoid
// revealing that a row exists at all, so a genuine ownership-filter denial
// on this instance should surface as 403, not 404 -- a 404 here would mean
// something other than the filter is responding (e.g. a wrong path) and
// must fail loudly like any other unexpected status.
function checkDenied(res, description) {
  assertionCount++;
  if (res.status !== 401 && res.status !== 403) {
    fail(`${description} -- expected 401/403, got ${res.status}: ${res.text}`);
  }
  console.log(`  ok - ${description} (${res.status})`);
}

// Unlike apply-chat-permissions.mjs's api(), this does not throw on a
// non-2xx response -- half of what this script does is confirm that
// specific requests fail, so the caller needs the status back, not an
// exception.
async function api(token, method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data, text };
}

async function login(label, email, password) {
  const res = await api(null, "POST", "/auth/login", { email, password });
  if (!res.ok || !res.data?.data?.access_token) {
    fail(`login as ${label} (${email}) failed (${res.status}): ${res.text}`);
  }
  return res.data.data.access_token;
}

console.log("Verifying chat_messages / chat_blocks per-user isolation.");
console.log(`Target: ${DIRECTUS_URL}`);

const tokenAdmin = await login("admin", ADMIN_EMAIL, ADMIN_PASSWORD);
const tokenA = await login("A", A_EMAIL, A_PASSWORD);
const tokenB = await login("B", B_EMAIL, B_PASSWORD);
console.log("Authenticated as admin, account A, and account B.\n");

const meA = await api(tokenA, "GET", "/users/me?fields=id");
if (!meA.ok || !meA.data?.data?.id) fail(`could not resolve account A's user id via /users/me (${meA.status}): ${meA.text}`);
const userA = meA.data.data.id;

const profiles = await api(tokenA, "GET", "/items/chat_profiles?limit=1&fields=id");
if (!profiles.ok || !(profiles.data?.data?.length > 0)) {
  fail(`no chat_profiles row exists to attach the probe message to (${profiles.status}): ${profiles.text} -- seed at least one buddy profile before running this`);
}
const profileId = profiles.data.data[0].id;

const now = new Date().toISOString();

// --- chat_messages ---
console.log("--- chat_messages ---");

const insertMsg = await api(tokenA, "POST", "/items/chat_messages", {
  user: userA,
  profile: profileId,
  direction: "in",
  body: `isolation probe ${now}`,
  virtual_time: now,
  created_at: now,
  kind: "typed",
});
if (!insertMsg.ok || !insertMsg.data?.data?.id) {
  fail(`account A could not insert a chat_messages probe row (${insertMsg.status}): ${insertMsg.text} -- cannot verify isolation without a real row`);
}
const msgId = insertMsg.data.data.id;
console.log(`  inserted chat_messages id=${msgId} as A`);

const readMsgAsB = await api(tokenB, "GET", `/items/chat_messages?filter[id][_eq]=${msgId}`);
if (!readMsgAsB.ok) fail(`account B's read of chat_messages errored unexpectedly (${readMsgAsB.status}): ${readMsgAsB.text}`);
const leakedMessages = readMsgAsB.data?.data ?? [];
if (leakedMessages.length !== 0) {
  console.error("\n*** PRIVACY INCIDENT: account B received another account's chat_messages row. ***");
  console.error(JSON.stringify(leakedMessages, null, 2));
  fail(`chat_messages cross-read returned ${leakedMessages.length} row(s) to account B -- fix the policy before running anything else against this database`);
}
check(true, "account B's read of A's chat_messages row returned zero rows");

const patchMsgAsB = await api(tokenB, "PATCH", `/items/chat_messages/${msgId}`, { body: "tampered by B" });
checkDenied(patchMsgAsB, "account B cannot PATCH A's chat_messages row");

const deleteMsgAsB = await api(tokenB, "DELETE", `/items/chat_messages/${msgId}`);
checkDenied(deleteMsgAsB, "account B cannot DELETE A's chat_messages row");

// --- chat_blocks ---
console.log("\n--- chat_blocks ---");

const insertBlock = await api(tokenAdmin, "POST", "/items/chat_blocks", {
  user: userA,
  scope: "profile",
  profile: profileId,
  reason: "isolation probe",
  evidence: "",
  created_at: now,
  expires: null,
});
if (!insertBlock.ok || !insertBlock.data?.data?.id) {
  fail(`admin could not insert a chat_blocks probe row for A (${insertBlock.status}): ${insertBlock.text}`);
}
const blockId = insertBlock.data.data.id;
console.log(`  inserted chat_blocks id=${blockId} (as admin, scoped to A)`);

const readBlockAsB = await api(tokenB, "GET", `/items/chat_blocks?filter[id][_eq]=${blockId}`);
if (!readBlockAsB.ok) fail(`account B's read of chat_blocks errored unexpectedly (${readBlockAsB.status}): ${readBlockAsB.text}`);
const leakedBlocks = readBlockAsB.data?.data ?? [];
if (leakedBlocks.length !== 0) {
  console.error("\n*** PRIVACY INCIDENT: account B received another account's chat_blocks row. ***");
  console.error(JSON.stringify(leakedBlocks, null, 2));
  fail(`chat_blocks cross-read returned ${leakedBlocks.length} row(s) to account B -- fix the policy before running anything else against this database`);
}
check(true, "account B's read of A's chat_blocks row returned zero rows");

const patchBlockAsB = await api(tokenB, "PATCH", `/items/chat_blocks/${blockId}`, { reason: "tampered by B" });
checkDenied(patchBlockAsB, "account B cannot PATCH A's chat_blocks row");

const deleteBlockAsB = await api(tokenB, "DELETE", `/items/chat_blocks/${blockId}`);
checkDenied(deleteBlockAsB, "account B cannot DELETE A's chat_blocks row");

// --- cleanup ---
console.log("\n--- cleanup (as admin — neither probe row is deletable by A) ---");

const cleanupMsg = await api(tokenAdmin, "DELETE", `/items/chat_messages/${msgId}`);
if (!cleanupMsg.ok) console.error(`WARNING: failed to delete probe chat_messages id=${msgId} (${cleanupMsg.status}): ${cleanupMsg.text} -- remove it by hand`);
else console.log(`  deleted chat_messages id=${msgId}`);

const cleanupBlock = await api(tokenAdmin, "DELETE", `/items/chat_blocks/${blockId}`);
if (!cleanupBlock.ok) console.error(`WARNING: failed to delete probe chat_blocks id=${blockId} (${cleanupBlock.status}): ${cleanupBlock.text} -- remove it by hand`);
else console.log(`  deleted chat_blocks id=${blockId}`);

console.log(`\nAll ${assertionCount} isolation assertions passed.`);
process.exit(0);
