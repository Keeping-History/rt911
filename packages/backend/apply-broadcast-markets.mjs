#!/usr/bin/env node
/**
 * Classify broadcast sources by who could receive them in 2001, and give each
 * chat profile a market.
 *
 * This is what stops a buddy in Columbus quoting 1010 WINS. Local sources reach
 * only their own market; national and international sources reach everyone;
 * outbound sources reach nobody in this US-only roster. A source left
 * unclassified still reaches everyone — dropping it would silently mute a newly
 * added channel — and the streamer logs the gap at boot instead.
 *
 * It classifies PROGRAMMING, not transmitters: a network affiliate is a local
 * transmitter but carried its network's national feed all day on 9/11, so it is
 * national. See CLASSIFICATION below.
 *
 * Adds `reach` + `market` to `sources` and `market` to `chat_profiles`, then
 * seeds the classification below. Dry run by default; pass --apply to write.
 * Idempotent: existing fields are left alone and every value is written with a
 * PATCH, so re-running converges rather than duplicating.
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

// Markets are slugs, not prose. chat_profiles.location stays human-readable for
// the persona ("Columbus, Ohio"); this is the join key.
const NEW_YORK = "new_york";

// Classification of every source that appears in chat_transcript_segments.
//
// This classifies PROGRAMMING, not transmitters. A network affiliate is a local
// transmitter, but on September 11 it carried its network's national feed all
// day — someone watching CBS in Ohio saw substantially what a Washington viewer
// watching WUSA saw. Marking affiliates market-exclusive would claim a
// distinction the tape does not contain, so they are national.
//
// That leaves `local` holding exactly the New York news radio: WINS and WCBS
// had their own newsrooms and no national feed, which is local content in a way
// an affiliate's 9/11 coverage simply was not.
//
// Ambiguous call signs were identified from their own transcripts rather than
// guessed: NEWSW carries a WABC feed and a reporter with "a clear view right at
// the World Trade Towers"; TCN says "8 o'clock Central time"; GLVSN and PSC are
// foreign-language/translator audio; WORLDNET is USIA documentary programming.
const CLASSIFICATION = {
  // Local content — New York news radio, the only genuinely market-exclusive
  // sources in this corpus.
  WINS: { reach: "local", market: NEW_YORK },
  WCBS: { reach: "local", market: NEW_YORK },

  // Network affiliates — local transmitters carrying national programming.
  WNYW: { reach: "national", market: null },
  WETA: { reach: "national", market: null },
  WJLA: { reach: "national", market: null },
  WRC: { reach: "national", market: null },
  WTTG: { reach: "national", market: null },
  WUSA: { reach: "national", market: null },
  WSBK: { reach: "national", market: null },

  // National cable — everyone with a television
  CNN: { reach: "national", market: null },
  MSNBC: { reach: "national", market: null },
  BET: { reach: "national", market: null },
  NEWSW: { reach: "national", market: null },
  TCN: { reach: "national", market: null },

  // International — available to all, per the design
  ANT1: { reach: "international", market: null },
  AZT: { reach: "international", market: null },
  BBC: { reach: "international", market: null },
  CCTV4: { reach: "international", market: null },
  IRAQ: { reach: "international", market: null },
  MCM: { reach: "international", market: null },
  NHK: { reach: "international", market: null },
  NTV: { reach: "international", market: null },
  GLVSN: { reach: "international", market: null },
  PSC: { reach: "international", market: null },

  // Private — recorded audio that was never broadcast to anyone. Same
  // provenance judgement that keeps these out of the transcript ingest: no
  // civilian could hear air traffic control, NEADS/NORAD, cockpit or
  // emergency-line tapes on the day, so no buddy can have heard them. Stated
  // here too so these 17 sources explain themselves instead of looking like an
  // uncurated gap on every streamer boot.
  AA11: { reach: "private", market: null },
  AA77: { reach: "private", market: null },
  UA93: { reach: "private", market: null },
  UA175: { reach: "private", market: null },
  DL1989: { reach: "private", market: null },
  atc: { reach: "private", market: null },
  ATCSCC: { reach: "private", market: null },
  FAA: { reach: "private", market: null },
  "NEADS/NORAD": { reach: "private", market: null },
  Langley: { reach: "private", market: null },
  GOFER06: { reach: "private", market: null },
  Rutgers: { reach: "private", market: null },
  QUIT: { reach: "private", market: null },
  ZDC: { reach: "private", market: null },
  ZNY: { reach: "private", market: null },
  ZOB: { reach: "private", market: null },
  ZBW: { reach: "private", market: null },

  // Outbound — USIA's international service, produced in the US for foreign
  // audiences and barred from domestic broadcast by the Smith-Mundt Act. No
  // American could have been watching it, so it reaches no buddy in this
  // roster.
  WORLDNET: { reach: "outbound", market: null },
};

// Seeded profiles live in Columbus, which the corpus has no station for — so
// they correctly receive national and international only. That is authentic:
// a kid in Ohio watched CNN, not Channel 5 New York.
// Danny is home sick with the TV on; Carol is in a school staff room. Both are
// in Columbus, so both are limited to national and international sources
// anyway — `watching` is what makes each one's "recently heard" block a single
// coherent channel rather than a blend of twenty-two.
const PROFILE_MARKETS = {
  skaterboi1988: { market: "columbus_oh", watching: "CNN" },
  mrsbeckwithteaches: { market: "columbus_oh", watching: "MSNBC" },
};

const FIELDS = [
  {
    collection: "sources",
    field: "reach",
    type: "string",
    meta: {
      interface: "select-dropdown",
      note: "How far this signal carried in 2001. Local sources reach only their own market.",
      options: {
        choices: [
          { text: "Local", value: "local" },
          { text: "National", value: "national" },
          { text: "International", value: "international" },
          { text: "Outbound (US service for foreign audiences)", value: "outbound" },
          { text: "Private (never broadcast: ATC, military, cockpit)", value: "private" },
        ],
      },
    },
    schema: { is_nullable: true },
  },
  {
    collection: "sources",
    field: "market",
    type: "string",
    meta: { note: "Broadcast market slug, e.g. new_york. Only meaningful when reach is local." },
    schema: { is_nullable: true },
  },
  {
    collection: "chat_profiles",
    field: "watching",
    type: "string",
    meta: {
      note: "Comma-separated source names this buddy actually had on, e.g. \"CNN\" or \"WNYW,WINS\". Empty means everything their market receives. Only ever narrows — a source outside their market is ignored.",
    },
    schema: { is_nullable: true },
  },
  {
    collection: "chat_profiles",
    field: "market",
    type: "string",
    meta: { note: "Which market's local signals this buddy could receive, e.g. new_york." },
    schema: { is_nullable: true },
  },
];

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

const summary = { fields: 0, sources: 0, profiles: 0, unmatched: [] };

for (const f of FIELDS) {
  let exists = true;
  try {
    await api(token, "GET", `/fields/${f.collection}/${f.field}`);
  } catch {
    exists = false;
  }
  if (exists) {
    console.log(`field ${f.collection}.${f.field}: already present`);
    continue;
  }
  console.log(`${APPLY ? "Creating" : "Would create"} field ${f.collection}.${f.field}`);
  if (APPLY) await api(token, "POST", `/fields/${f.collection}`, f);
  summary.fields++;
}

// Match on name, which is what the call signs in CLASSIFICATION are. Anything
// in the table we have no entry for is reported rather than silently skipped —
// an unclassified source stays audible to everyone, so a curator needs to see it.
const sources = (await api(token, "GET", "/items/sources?fields=id,name,reach,market&limit=-1")).data;
const byName = new Map(sources.map((s) => [s.name, s]));

for (const [name, want] of Object.entries(CLASSIFICATION)) {
  const row = byName.get(name);
  if (!row) {
    summary.unmatched.push(name);
    continue;
  }
  if (row.reach === want.reach && (row.market ?? null) === want.market) continue;
  console.log(
    `${APPLY ? "Setting" : "Would set"} ${name}: reach=${want.reach} market=${want.market ?? "—"}`,
  );
  if (APPLY) await api(token, "PATCH", `/items/sources/${row.id}`, want);
  summary.sources++;
}

const profiles = (await api(token, "GET", "/items/chat_profiles?fields=id,screen_name,market,watching&limit=-1")).data;
for (const p of profiles) {
  const want = PROFILE_MARKETS[p.screen_name];
  if (!want) continue;
  if (p.market === want.market && p.watching === want.watching) continue;
  console.log(
    `${APPLY ? "Setting" : "Would set"} profile ${p.screen_name}: market=${want.market} watching=${want.watching}`,
  );
  if (APPLY) await api(token, "PATCH", `/items/chat_profiles/${p.id}`, want);
  summary.profiles++;
}

const classifiedNames = new Set(Object.keys(CLASSIFICATION));
const unclassifiedInUse = sources
  .filter((s) => !classifiedNames.has(s.name) && !s.reach)
  .map((s) => s.name);

console.log("\n--- Summary ---");
console.log(`Fields ${APPLY ? "created" : "to create"}: ${summary.fields}`);
console.log(`Sources ${APPLY ? "classified" : "to classify"}: ${summary.sources}`);
console.log(`Profiles ${APPLY ? "updated" : "to update"}: ${summary.profiles}`);
if (summary.unmatched.length) {
  console.log(`\nIn CLASSIFICATION but not in sources: ${summary.unmatched.join(", ")}`);
}
if (unclassifiedInUse.length) {
  console.log(
    `\nUnclassified sources (these still reach EVERY buddy — classify any that are local):\n  ${unclassifiedInUse.join(", ")}`,
  );
}
if (!APPLY) console.log("\nDry run complete. Re-run with --apply to write.");
if (APPLY) console.log("\nThe streamer loads this once at boot — restart it to pick these up.");
