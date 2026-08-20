#!/usr/bin/env node
/**
 * Seed a small demonstration set for IM Buddies: story beacons, two buddy
 * profiles, and an emotional arc for each.
 *
 * This is starter content, not the finished product. The design treats profiles,
 * beacons and phases as editorial material curated in the Directus admin UI —
 * this script exists so the dev harness has something real to show and so the
 * shape of a well-formed record is documented in one place. Expect a curator to
 * rewrite the personas and extend the beacon list.
 *
 * Dry run by default; pass --apply to write. Idempotent: it skips any beacon
 * whose `key` already exists and any profile whose `screen_name` already exists,
 * so re-running never duplicates.
 *
 * Not to be confused with seed.mjs, which also bulk-imports media, news and
 * pager data and must never be pointed at a live instance to add a collection.
 */

const APPLY = process.argv.includes("--apply");

// Directus-owned collections go over the REST API, matching apply-chat-schema.mjs
// and the rest of this repo's Directus writes — no driver dependency, and Directus
// records the rows the same way the admin UI would.
const DIRECTUS_URL = required("DIRECTUS_URL");
const ADMIN_EMAIL = required("ADMIN_EMAIL");
const ADMIN_PASSWORD = required("ADMIN_PASSWORD");

function required(name) {
  const v = process.env[name];
  if (!v) {
    // No localhost default on purpose: a silent fallback is how you seed the
    // wrong instance without noticing.
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return v;
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

// September 11, 2001 was EDT (UTC-4), so 8:46 a.m. ET is 12:46 UTC.
//
// `at` values are the well-documented times of the events themselves.
// `public_at` is when each first reached a general television audience and is
// deliberately approximate — it is the number a curator should refine, because
// it is what decides when a buddy's mood is allowed to change. Where an event
// happened live on air the two are identical.
const BEACONS = [
  {
    key: "first_impact",
    label: "North tower struck",
    at: "2001-09-11T12:46:00Z",
    public_at: "2001-09-11T12:51:00Z",
    description:
      "American 11 strikes the north tower. Networks break in a few minutes later; " +
      "the earliest reports describe a small plane and an accident.",
  },
  {
    key: "second_impact",
    label: "South tower struck",
    at: "2001-09-11T13:03:00Z",
    public_at: "2001-09-11T13:03:00Z",
    description:
      "United 175 strikes the south tower, live on air. This is the moment an " +
      "accident becomes visibly something else.",
  },
  {
    key: "pentagon",
    label: "Pentagon struck",
    at: "2001-09-11T13:37:00Z",
    public_at: "2001-09-11T13:43:00Z",
    description: "American 77 strikes the Pentagon; reported a few minutes afterwards.",
  },
  {
    key: "tower2_collapse",
    label: "South tower collapses",
    at: "2001-09-11T13:59:00Z",
    public_at: "2001-09-11T13:59:00Z",
    description: "The south tower collapses, live on air.",
  },
  {
    key: "ua93",
    label: "United 93 crashes",
    at: "2001-09-11T14:03:00Z",
    public_at: "2001-09-11T14:15:00Z",
    description:
      "United 93 crashes in Somerset County, Pennsylvania. Not immediately " +
      "understood; early reports are of an unexplained crash.",
  },
  {
    key: "tower1_collapse",
    label: "North tower collapses",
    at: "2001-09-11T14:28:00Z",
    public_at: "2001-09-11T14:28:00Z",
    description: "The north tower collapses, live on air.",
  },
];

// Two profiles, deliberately different in age and distance from New York, so the
// harness shows the design's central idea: the same day reaches two people
// differently. Both are fictional.
const PROFILES = [
  {
    screen_name: "skaterboi1988",
    display_name: "Danny",
    persona:
      "You are Danny, 13, in eighth grade in Columbus, Ohio. You are home sick " +
      "from school today with a cold, watching TV in the living room. Your mom " +
      "is at work and your older sister is at school. You are into skateboarding, " +
      "Tony Hawk's Pro Skater, and Blink-182. You have never been to New York.",
    education_level: "middle",
    writing_style:
      "You type in lowercase without punctuation. You use AIM shorthand: u, ur, " +
      "r, brb, g2g, omg, lol, wut. Short messages, often several in a row rather " +
      "than one long one. Text emoticons only, like :-) and :-/ and :-O.",
    style_exemplars:
      "yo\ndid u see the new tony hawk\nmy mom wont let me get it lol\nbrb\n" +
      "wut r u doing after school",
    location: "Columbus, Ohio",
    timezone: "America/New_York",
    typing_speed: 4,
  },
  {
    screen_name: "mrsbeckwithteaches",
    display_name: "Carol",
    persona:
      "You are Carol, 41, a high school English teacher in Columbus, Ohio, on a " +
      "free period in the staff room. You are Danny's aunt. You have a brother " +
      "who travels for work and you are not certain where he is flying today. " +
      "You are calm by temperament and used to being the steady one.",
    education_level: "adult",
    writing_style:
      "You write in complete sentences with correct punctuation and capitalisation. " +
      "You are warm but measured. You rarely use abbreviations and never use " +
      "emoticons. When you are frightened you become more formal, not less.",
    style_exemplars:
      "Good morning — are you feeling any better today?\n" +
      "I have a free period until eleven, so I can talk for a little while.\n" +
      "Please don't worry about the homework. It can wait.",
    location: "Columbus, Ohio",
    timezone: "America/New_York",
    typing_speed: 7,
  },
];

// Dials are 0-100. Coherence is the one whose polarity runs opposite the others:
// low coherence means struggling to finish a thought, so an unshaken person sits
// HIGH on coherence and LOW on shock.
const PHASES = {
  skaterboi1988: [
    { beacon: null, tone: "bored and a bit stir-crazy at home sick", shock: 0, coherence: 90, verbosity: 30, typo_rate: 55, topic_focus: 0 },
    { beacon: "first_impact", tone: "curious, treating it as a strange accident on the news", shock: 20, coherence: 85, verbosity: 35, typo_rate: 60, topic_focus: 45 },
    { beacon: "second_impact", tone: "frightened and asking a lot of questions", shock: 65, coherence: 55, verbosity: 25, typo_rate: 75, topic_focus: 90 },
    { beacon: "tower2_collapse", tone: "overwhelmed, wanting your mom", shock: 90, coherence: 30, verbosity: 15, typo_rate: 80, topic_focus: 100 },
    { beacon: "tower1_collapse", tone: "quiet and subdued, out of questions", shock: 75, coherence: 45, verbosity: 15, typo_rate: 60, topic_focus: 95 },
  ],
  mrsbeckwithteaches: [
    { beacon: null, tone: "settled, in the middle of an ordinary working morning", shock: 0, coherence: 100, verbosity: 60, typo_rate: 0, topic_focus: 0 },
    { beacon: "first_impact", tone: "concerned but composed, wanting more information before reacting", shock: 25, coherence: 95, verbosity: 55, typo_rate: 5, topic_focus: 50 },
    { beacon: "second_impact", tone: "shaken, and working hard to stay steady for a child", shock: 60, coherence: 85, verbosity: 45, typo_rate: 10, topic_focus: 85 },
    { beacon: "pentagon", tone: "frightened and quietly worried about your brother's travel", shock: 80, coherence: 75, verbosity: 40, typo_rate: 15, topic_focus: 95 },
    { beacon: "tower1_collapse", tone: "grieving, gentle, focused on reassurance rather than facts", shock: 70, coherence: 80, verbosity: 50, typo_rate: 10, topic_focus: 90 },
  ],
};

const summary = { beacons: 0, profiles: 0, phases: 0, skipped: [] };

if (!APPLY) console.log("DRY RUN — no changes will be made (pass --apply to apply).");
console.log(`Target: ${DIRECTUS_URL}`);
const token = await login();
console.log("Authenticated.\n");

{
  const existing = (await api(token, "GET", "/items/chat_beacons?fields=id,key&limit=-1")).data;
  const existingBeacons = new Set(existing.map((r) => r.key));
  const beaconIds = new Map(existing.map((r) => [r.key, r.id]));

  for (const b of BEACONS) {
    if (existingBeacons.has(b.key)) {
      summary.skipped.push(`beacon ${b.key}`);
      continue;
    }
    console.log(`${APPLY ? "Creating" : "Would create"} beacon: ${b.key}`);
    if (APPLY) {
      const r = await api(token, "POST", "/items/chat_beacons", {
        key: b.key, label: b.label, at: b.at, public_at: b.public_at, description: b.description,
      });
      beaconIds.set(b.key, r.data.id);
    }
    summary.beacons++;
  }

  const existingProfiles = new Set(
    (await api(token, "GET", "/items/chat_profiles?fields=screen_name&limit=-1")).data
      .map((r) => r.screen_name),
  );

  for (const [i, p] of PROFILES.entries()) {
    if (existingProfiles.has(p.screen_name)) {
      summary.skipped.push(`profile ${p.screen_name}`);
      continue;
    }
    console.log(`${APPLY ? "Creating" : "Would create"} profile: ${p.screen_name}`);
    let profileId = null;
    if (APPLY) {
      const r = await api(token, "POST", "/items/chat_profiles", {
        screen_name: p.screen_name, display_name: p.display_name, persona: p.persona,
        education_level: p.education_level, writing_style: p.writing_style,
        style_exemplars: p.style_exemplars, location: p.location, timezone: p.timezone,
        typing_speed: p.typing_speed, active: 1, sort: i,
      });
      profileId = r.data.id;
    }
    summary.profiles++;

    for (const [j, ph] of (PHASES[p.screen_name] ?? []).entries()) {
      console.log(`  ${APPLY ? "  +" : "  would add"} phase ${j}: ${ph.beacon ?? "(opening)"}`);
      if (APPLY) {
        await api(token, "POST", "/items/chat_phases", {
          profile: profileId, from_beacon: ph.beacon ? beaconIds.get(ph.beacon) : null,
          tone: ph.tone, shock: ph.shock, coherence: ph.coherence, verbosity: ph.verbosity,
          typo_rate: ph.typo_rate, topic_focus: ph.topic_focus, sort: j,
        });
      }
      summary.phases++;
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Beacons ${APPLY ? "created" : "to create"}: ${summary.beacons}`);
  console.log(`Profiles ${APPLY ? "created" : "to create"}: ${summary.profiles}`);
  console.log(`Phases ${APPLY ? "created" : "to create"}: ${summary.phases}`);
  if (summary.skipped.length) console.log(`Skipped (already present): ${summary.skipped.join(", ")}`);
  if (!APPLY) console.log("\nDry run complete. Re-run with --apply to write.");
  if (APPLY) console.log("\nThe streamer loads profiles once at boot — restart it to pick these up.");
}
