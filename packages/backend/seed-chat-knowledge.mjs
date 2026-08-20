#!/usr/bin/env node
/**
 * Seed the tier-1 curated timeline (chat_knowledge).
 *
 * This is the only tier a buddy may state plainly. Tier 2 is raw transcript and
 * tier 3 must be paraphrased vaguely, so with this table empty a character can
 * only ever half-quote whatever happened to be on their television.
 *
 * Two fields carry most of the design:
 *
 *   public_at — when an ordinary person watching television could have known
 *     this, NOT when it happened. The Pentagon was struck at 9:37 but was not
 *     on national TV for several minutes, and a buddy must not react to an
 *     event before it was knowable.
 *
 *   until — when a claim stopped being current, because it was corrected or
 *     superseded. Early reporting on September 11 was wrong in specific,
 *     well-documented ways, and that wrongness is the texture of the morning.
 *     A buddy saying "theyre saying it was a small plane" at 8:52 is more
 *     authentic than one saying "a 767 hit the north tower", even though only
 *     the second is true. Rows with an `until` stop being retrieved after it.
 *
 * certainty (rumor / reported / confirmed) tells the composer how hard a fact
 * may be stated. sensitivity handle_with_care marks the human cost; the
 * composer softens those, and a curator can raise one to do_not_discuss to have
 * Redact drop it before it ever reaches a model.
 *
 * This is a STARTER SET (~40 rows) covering the major beats, deliberately
 * skewed toward what national television carried, because the seeded buddies
 * are in Ohio watching CNN and MSNBC. It is meant to be extended and corrected
 * by someone who knows the material — not treated as finished.
 *
 * Dry run by default; pass --apply to write. Idempotent: skips any row whose
 * summary already exists, so re-running never duplicates.
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

// September 11, 2001 was EDT, so ET + 4 = UTC. Times below are the moment the
// claim reached a general television audience.
const Z = (hhmm, day = 11) => `2001-09-${day}T${hhmm}:00Z`;

const ROWS = [
  // ---- The first impact, and the hour when nobody knew what it was ----
  {
    public_at: Z("12:50"), until: Z("13:10"),
    summary: "Something has hit one of the World Trade Center towers.",
    detail: "The first bulletins say only that there has been an explosion or a crash at the north tower. Nobody on air knows what kind of aircraft it was, or whether it was an accident.",
    certainty: "reported", topics: "wtc,first_impact", sensitivity: "normal",
  },
  {
    public_at: Z("12:52"), until: Z("13:10"),
    summary: "They are saying it might have been a small plane that went off course.",
    detail: "Early reports describe a small commuter plane or a private aircraft, and several anchors suggest it looks like a terrible accident. This turns out to be wrong, but it is what people believed for the first fifteen minutes.",
    certainty: "rumor", topics: "wtc,first_impact,early_error", sensitivity: "normal",
  },
  {
    public_at: Z("12:51"),
    summary: "There is a large hole near the top of the north tower and a lot of smoke.",
    detail: "The tower is burning across several floors and thick black smoke is blowing south. Every network has a live camera on it within a few minutes.",
    certainty: "confirmed", topics: "wtc,first_impact", sensitivity: "normal",
  },

  // ---- The second impact: the moment it stops being an accident ----
  {
    public_at: Z("13:03"),
    summary: "A second plane has hit the other tower, live on television.",
    detail: "A jet comes in from the left of the picture and hits the south tower while cameras are already pointed at the first fire. Almost everyone watching sees it happen.",
    certainty: "confirmed", topics: "wtc,second_impact", sensitivity: "normal",
  },
  {
    public_at: Z("13:05"),
    summary: "Both planes were airliners, not small planes. This was done on purpose.",
    detail: "After the second impact the anchors stop talking about an accident. It is now obviously deliberate, and the tone of the coverage changes completely.",
    certainty: "confirmed", topics: "wtc,second_impact,attack", sensitivity: "normal",
  },
  {
    public_at: Z("13:15"),
    summary: "Nobody knows yet who did this or whether more planes are coming.",
    detail: "For most of the morning the honest answer to almost every question is that nobody knows. Anchors say so repeatedly.",
    certainty: "reported", topics: "attack,uncertainty", sensitivity: "normal",
  },

  // ---- Aviation ----
  {
    public_at: Z("13:20"),
    summary: "The planes that hit the towers were hijacked passenger flights.",
    detail: "Both were transcontinental flights out of Boston with full fuel loads. There were passengers and crew aboard.",
    certainty: "reported", topics: "aviation,hijack", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("13:48"),
    summary: "Every airport in the country is being shut down.",
    detail: "The FAA has stopped all takeoffs nationwide and is ordering every aircraft in American airspace to land at the nearest airport. Nothing like it has been done before.",
    certainty: "confirmed", topics: "aviation,faa", sensitivity: "normal",
  },
  {
    public_at: Z("14:10"), until: Z("16:30"),
    summary: "They are saying there may be six or more hijacked planes still in the air.",
    detail: "Through the late morning the number of unaccounted-for aircraft keeps changing on air. Most of these reports turn out to be duplicates or aircraft that simply had not checked in.",
    certainty: "rumor", topics: "aviation,early_error", sensitivity: "normal",
  },
  {
    public_at: Z("16:30"),
    summary: "American airspace is empty except for military aircraft.",
    detail: "Every civilian flight has landed. For the first time, the sky over the United States is closed.",
    certainty: "confirmed", topics: "aviation,faa", sensitivity: "normal",
  },

  // ---- The Pentagon ----
  {
    public_at: Z("13:43"),
    summary: "A plane has hit the Pentagon.",
    detail: "There is a fire on one side of the building and a column of smoke over Washington. Part of the building later collapses.",
    certainty: "confirmed", topics: "pentagon", sensitivity: "normal",
  },
  {
    public_at: Z("13:50"),
    summary: "The Pentagon is being evacuated, and so is the White House.",
    detail: "People are streaming out of federal buildings all over Washington. The Capitol and the State Department are cleared as well.",
    certainty: "reported", topics: "pentagon,washington", sensitivity: "normal",
  },
  {
    public_at: Z("14:20"), until: Z("15:30"),
    summary: "There are reports of a car bomb at the State Department.",
    detail: "This is broadcast on national television during the late morning and repeated for a while. It is not true, and it is retracted within the hour.",
    certainty: "rumor", topics: "washington,early_error", sensitivity: "normal",
  },
  {
    public_at: Z("14:25"), until: Z("15:30"),
    summary: "Someone said there is a fire on the National Mall.",
    detail: "Another report from the confused hour after the Pentagon was hit. It is wrong.",
    certainty: "rumor", topics: "washington,early_error", sensitivity: "normal",
  },

  // ---- The collapses ----
  {
    public_at: Z("13:59"),
    summary: "The south tower has collapsed.",
    detail: "It comes down in about ten seconds and a gray cloud rolls through the streets of lower Manhattan. On air, several people do not immediately understand what they have just watched.",
    certainty: "confirmed", topics: "wtc,collapse", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("14:28"),
    summary: "The north tower has collapsed too. Both towers are gone.",
    detail: "The second collapse is about half an hour after the first. The skyline everyone recognizes is simply not there any more.",
    certainty: "confirmed", topics: "wtc,collapse", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("14:35"),
    summary: "Lower Manhattan is covered in a thick gray dust.",
    detail: "People are walking out of the cloud covered head to foot in it. It is on the cars, the streets, everything, for blocks.",
    certainty: "confirmed", topics: "wtc,collapse,nyc", sensitivity: "normal",
  },
  {
    public_at: Z("21:25"),
    summary: "A third World Trade Center building, number seven, has collapsed this evening.",
    detail: "It burned all afternoon after the towers came down and fell late in the day. Nobody was killed in it.",
    certainty: "confirmed", topics: "wtc,collapse", sensitivity: "normal",
  },

  // ---- Flight 93 ----
  {
    public_at: Z("14:15"),
    summary: "A plane has come down in a field in Pennsylvania.",
    detail: "At first it is just an unexplained crash in Somerset County, southeast of Pittsburgh, and nobody on air connects it to the rest of the morning.",
    certainty: "reported", topics: "ua93", sensitivity: "normal",
  },
  {
    public_at: Z("16:00"),
    summary: "The Pennsylvania plane was hijacked too. It was a United flight.",
    detail: "It went down in open farmland and nobody on the ground was hurt.",
    certainty: "reported", topics: "ua93,hijack", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("22:00"),
    summary: "People on the Pennsylvania flight had called home and knew what was happening.",
    detail: "Passengers used air phones and cell phones, learned about the other planes, and decided to act. This is the story that begins to circulate by evening.",
    certainty: "reported", topics: "ua93,passengers", sensitivity: "handle_with_care",
  },

  // ---- New York on the ground ----
  {
    public_at: Z("14:50"),
    summary: "Firefighters and police went into the towers before they fell.",
    detail: "Hundreds of them were inside or at the base of the buildings when the collapses happened.",
    certainty: "reported", topics: "nyc,responders", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("15:05"),
    summary: "Lower Manhattan is being evacuated on foot.",
    detail: "The subways and bridges into the area are closed, so people are walking north and over the bridges in enormous crowds.",
    certainty: "confirmed", topics: "nyc,evacuation", sensitivity: "normal",
  },
  {
    public_at: Z("15:30"),
    summary: "The hospitals are waiting for casualties who mostly never arrive.",
    detail: "Emergency rooms across the city cleared space and lined up staff. Far fewer injured people come in than anyone expects, which people understand later means most of those inside did not get out.",
    certainty: "reported", topics: "nyc,casualties", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("16:45"),
    summary: "People are lining up to give blood all over the country.",
    detail: "Donation centers run out of capacity and ask people to come back another day.",
    certainty: "confirmed", topics: "response,blood", sensitivity: "normal",
  },
  {
    public_at: Z("19:00"),
    summary: "People are putting up photographs of relatives they cannot find.",
    detail: "Handwritten missing-person flyers go up on walls, fences and pay phones around the city, with names and photographs and phone numbers.",
    certainty: "reported", topics: "nyc,missing", sensitivity: "handle_with_care",
  },

  // ---- Government response ----
  {
    public_at: Z("13:10"),
    summary: "The President was at a school in Florida when it happened.",
    detail: "He was reading with a class of children when he was told about the second plane.",
    certainty: "confirmed", topics: "bush,government", sensitivity: "normal",
  },
  {
    public_at: Z("13:35"),
    summary: "The President has called it an apparent terrorist attack on our country.",
    detail: "He makes a short statement from the school in Florida before leaving.",
    certainty: "confirmed", topics: "bush,government", sensitivity: "normal",
  },
  {
    public_at: Z("17:10"),
    summary: "The President is being moved around the country on Air Force One.",
    detail: "He does not return to Washington straight away. He speaks briefly from an air base in Louisiana in the early afternoon.",
    certainty: "reported", topics: "bush,government", sensitivity: "normal",
  },
  {
    public_at: Z("18:00"),
    summary: "The military has been put on its highest alert.",
    detail: "Fighter aircraft are flying over New York and Washington, and warships are moved off both coasts.",
    certainty: "reported", topics: "military,government", sensitivity: "normal",
  },
  {
    public_at: Z("19:30"),
    summary: "Every federal building in Washington is closed and the United Nations has been evacuated.",
    detail: "Government offices in other cities close too, and many schools send children home early.",
    certainty: "confirmed", topics: "washington,government", sensitivity: "normal",
  },
  {
    public_at: Z("23:00"),
    summary: "The President is back at the White House.",
    detail: "He returns to Washington in the evening after stops in Louisiana and Nebraska.",
    certainty: "confirmed", topics: "bush,government", sensitivity: "normal",
  },
  {
    public_at: Z("00:30", 12),
    summary: "The President has spoken to the country from the White House.",
    detail: "A short address in the evening. He says the country was attacked because it is a beacon for freedom, and that America and its friends will stand together.",
    certainty: "confirmed", topics: "bush,government", sensitivity: "normal",
  },

  // ---- Who did it ----
  {
    public_at: Z("15:00"), until: Z("17:00"),
    summary: "People are guessing about who is responsible, but nobody official is saying.",
    detail: "Several groups and countries get named on air during the day with no evidence behind it. Officials refuse to confirm anything for hours.",
    certainty: "rumor", topics: "attack,attribution,early_error", sensitivity: "normal",
  },
  {
    public_at: Z("18:30"),
    summary: "Officials are pointing at Osama bin Laden, without saying so on the record.",
    detail: "Unnamed sources tell reporters the attack looks like al-Qaeda. There is no formal accusation on the day itself.",
    certainty: "reported", topics: "attack,attribution", sensitivity: "normal",
  },

  // ---- The human cost ----
  {
    public_at: Z("15:15"),
    summary: "Some people fell or jumped from the towers before they came down.",
    detail: "It was visible on live television for a while during the morning and several networks stopped showing it. It is one of the hardest parts of the day for people who saw it.",
    certainty: "reported", topics: "wtc,casualties", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("16:00"), until: Z("00:00", 12),
    summary: "Nobody knows how many people have died, and the early guesses are enormous.",
    detail: "Estimates on air run into many thousands because the towers held tens of thousands of workers on an ordinary weekday. The real figure, which takes a long time to establish, is far lower than the worst fears of the day.",
    certainty: "rumor", topics: "casualties,early_error", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("22:30"),
    summary: "The mayor of New York was asked about the death toll and said it would be more than any of us can bear.",
    detail: "He declines to give a number, saying it is too early and it would not be right to guess.",
    certainty: "confirmed", topics: "nyc,casualties", sensitivity: "handle_with_care",
  },
  {
    public_at: Z("20:00"),
    summary: "There were people from a great many countries in the towers.",
    detail: "The World Trade Center held offices of international banks and firms, so the people killed came from dozens of nations.",
    certainty: "reported", topics: "casualties,international", sensitivity: "handle_with_care",
  },

  // ---- Ordinary life, which is where most of a conversation actually lives ----
  {
    public_at: Z("14:00"),
    summary: "Schools are deciding whether to tell the children or send them home.",
    detail: "Some schools put televisions on, some deliberately do not, and many parents come to collect their children early.",
    certainty: "reported", topics: "schools,ordinary_life", sensitivity: "normal",
  },
  {
    public_at: Z("15:00"),
    summary: "Phone lines are jammed and it is hard to reach anyone.",
    detail: "Long distance and cell networks are overloaded all day, especially into New York. Sometimes a call goes through on the fifth or sixth try.",
    certainty: "confirmed", topics: "phones,ordinary_life", sensitivity: "normal",
  },
  {
    public_at: Z("16:00"),
    summary: "Baseball and just about everything else has been cancelled.",
    detail: "Major League Baseball postpones its games, Broadway goes dark, and Disney parks close. Almost nothing normal happens for the rest of the day.",
    certainty: "confirmed", topics: "ordinary_life,cancellations", sensitivity: "normal",
  },
  {
    public_at: Z("17:30"),
    summary: "Gas stations in some places have put their prices way up and there are long lines.",
    detail: "A few stations raise prices sharply during the afternoon and some states say they will go after price gouging.",
    certainty: "reported", topics: "ordinary_life", sensitivity: "normal",
  },
  {
    public_at: Z("18:00"),
    summary: "The stock markets did not open and will stay closed.",
    detail: "The exchanges are a few blocks from the World Trade Center. They stay shut for the rest of the week.",
    certainty: "confirmed", topics: "markets,ordinary_life", sensitivity: "normal",
  },
  {
    public_at: Z("23:30"),
    summary: "People are standing outside with candles.",
    detail: "Small vigils happen in towns all over the country during the evening, and churches open their doors.",
    certainty: "reported", topics: "response,vigils,ordinary_life", sensitivity: "normal",
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

// Every row must land inside the window the chat channel runs in, or it can
// never be retrieved -- a silently unreachable curated fact is worse than a
// missing one, because it looks authored.
const WINDOW_START = Date.parse("2001-09-11T12:00:00Z");
const WINDOW_END = Date.parse("2001-09-12T04:00:00Z");

const problems = [];
for (const r of ROWS) {
  const at = Date.parse(r.public_at);
  if (Number.isNaN(at)) problems.push(`unparseable public_at: ${r.summary}`);
  else if (at < WINDOW_START || at >= WINDOW_END) problems.push(`outside the chat window: ${r.summary}`);
  if (r.until && Date.parse(r.until) <= at) problems.push(`until is not after public_at: ${r.summary}`);
  if (!["rumor", "reported", "confirmed"].includes(r.certainty)) problems.push(`bad certainty: ${r.summary}`);
  if (!["normal", "handle_with_care", "do_not_discuss"].includes(r.sensitivity)) problems.push(`bad sensitivity: ${r.summary}`);
}
if (problems.length) {
  console.error("Refusing to seed — fix these first:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (!APPLY) console.log("DRY RUN — no changes will be made (pass --apply to apply).");
console.log(`Target: ${DIRECTUS_URL}`);
const token = await login();

const existing = new Set(
  (await api(token, "GET", "/items/chat_knowledge?fields=summary&limit=-1")).data.map((r) => r.summary),
);

let created = 0;
let skipped = 0;
for (const r of ROWS) {
  if (existing.has(r.summary)) {
    skipped++;
    continue;
  }
  console.log(`${APPLY ? "Creating" : "Would create"} [${r.certainty}] ${r.public_at.slice(11, 16)} ${r.summary}`);
  if (APPLY) await api(token, "POST", "/items/chat_knowledge", r);
  created++;
}

const superseded = ROWS.filter((r) => r.until).length;
const care = ROWS.filter((r) => r.sensitivity === "handle_with_care").length;

console.log("\n--- Summary ---");
console.log(`Rows ${APPLY ? "created" : "to create"}: ${created}`);
console.log(`Already present, skipped: ${skipped}`);
console.log(`Of these, superseded later in the day (carry an \`until\`): ${superseded}`);
console.log(`Marked handle_with_care: ${care}`);
if (!APPLY) console.log("\nDry run complete. Re-run with --apply to write.");
