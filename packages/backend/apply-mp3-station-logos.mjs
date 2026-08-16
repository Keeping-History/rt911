/**
 * apply-mp3-station-logos.mjs
 *
 * Normalizes station logo artwork on the broadcast stations' mp3_items rows,
 * pointing every row's `image` field at the station's logo on Wasabi. The
 * Radio Tuner renders the tuned station's artwork from the streamed items'
 * `image` (see packages/frontend/src/Applications/RadioScanner/
 * stationGrouping.ts → stationLogo), falling back to the text call sign for
 * stations with no artwork — so this script is the whole data side of that
 * feature.
 *
 * The logo files live in Wasabi only (this repo carries no media): the
 * serving copies are the STATION_LOGOS URLs below (downscaled for display),
 * and the untouched source art is archived beside them under
 * images/radio/original/. This script verifies each serving URL answers 200
 * and refuses to write rows that would point at a 404. To change a logo,
 * upload the new file over the same key with the video-grabber Wasabi
 * credentials (see packages/tools/video-grabber/.env.example for the env
 * names):
 *
 *   aws s3 cp new-logo.png \
 *     s3://files.911realtime.org/images/radio/<slug>.png \
 *     --endpoint-url https://s3.us-central-1.wasabisys.com \
 *     --content-type image/png
 *
 * …and an in-place re-upload of an existing key MUST be followed by a
 * Cloudflare purge of that URL, or the old bytes serve until the cache
 * expires (the CF cache is query-agnostic, so a cache-buster query won't
 * help).
 *
 * Every station row is normalized to the canonical logo, including rows
 * carrying older or external artwork (the first run replaced an ingest-era
 * /audio/wins1010/image.jpg on 24 WINS rows and a hotlinked Wikipedia logo
 * on one WCBS row), so the script is idempotent and safe to re-run as new
 * recordings are ingested. No permission changes are made — the Radio Tuner
 * receives items over the streamer's WebSocket (internal/db reads Postgres
 * directly), not anonymous REST, so the public mp3_items field list is not
 * involved.
 *
 * The streamer needs no restart: each row UPDATE fires the mp3_items NOTIFY
 * trigger and cache.ListenMp3 upserts the changed rows into Redis live.
 *
 * Usage:
 *   node apply-mp3-station-logos.mjs            # dry run (default) — verifies
 *                                                # the asset URLs, reports row
 *                                                # counts, makes no writes
 *   node apply-mp3-station-logos.mjs --apply    # writes the image URLs
 *
 * Required env (no defaults, on purpose — a silent default is how you
 * configure the wrong instance):
 *   DIRECTUS_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 */

const APPLY = process.argv.includes("--apply");

// source slug (mp3_items.source / BROADCAST_STATIONS key) → logo URL.
// Add a row here when a new broadcast station gets artwork.
const STATION_LOGOS = {
  WCBS: "https://files.911realtime.org/images/radio/wcbs.png",
  WINS: "https://files.911realtime.org/images/radio/wins.png",
};

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

async function api(token, method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      // Skip Directus's response cache (CACHE_SKIP_ALLOWED is on for this
      // instance) — without this, the row counts read back stale for a few
      // minutes after a write and the report claims nothing was updated.
      "Cache-Control": "no-store",
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
  return JSON.parse(text).data.access_token;
}

// Fail closed: never point rows at an asset that isn't actually being served.
// HEAD first; some proxies reject HEAD, so fall back to a 1-byte ranged GET.
async function assertAssetLive(url) {
  let res = await fetch(url, { method: "HEAD" });
  if (res.status === 405 || res.status === 501) {
    res = await fetch(url, { headers: { Range: "bytes=0-0" } });
  }
  if (!res.ok) {
    throw new Error(
      `${url} → HTTP ${res.status}. Upload the logo to Wasabi first (see the header of this script for the exact aws s3 cp commands), then re-run.`,
    );
  }
}

async function countWhere(token, filter) {
  const res = await api(
    token,
    "GET",
    `/items/mp3_items?filter=${encodeURIComponent(JSON.stringify(filter))}&aggregate[count]=id`,
  );
  return Number(res.data[0]?.count?.id ?? res.data[0]?.count ?? 0);
}

console.log(
  APPLY
    ? "Applying mp3_items station logos…"
    : "DRY RUN — no changes will be made (pass --apply to apply).",
);
console.log(`Target: ${DIRECTUS_URL}`);

for (const url of Object.values(STATION_LOGOS)) {
  await assertAssetLive(url);
  console.log(`asset live: ${url}`);
}

const token = await login();
let wrote = 0;

// Sequential on purpose — parallel Directus REST loops have returned mixed-up
// response bodies against this instance before. Do not Promise.all this.
for (const [source, url] of Object.entries(STATION_LOGOS)) {
  const total = await countWhere(token, { source: { slug: { _eq: source } } });
  const done = await countWhere(token, {
    _and: [{ source: { slug: { _eq: source } } }, { image: { _eq: url } }],
  });
  const stale = total - done;

  console.log(
    `${source}: ${total} rows — ${done} already canonical, ${stale} to normalize`,
  );
  if (total === 0) {
    console.warn(`  WARNING: no mp3_items rows have source=${source} — check the slug.`);
    continue;
  }
  if (stale === 0) continue;

  if (APPLY) {
    await api(token, "PATCH", "/items/mp3_items", {
      query: {
        filter: {
          _and: [
            { source: { slug: { _eq: source } } },
            { _or: [{ image: { _null: true } }, { image: { _neq: url } }] },
          ],
        },
        limit: -1,
      },
      data: { image: url },
    });
    console.log(`  set image on ${stale} ${source} rows`);
    wrote += stale;
  } else {
    console.log(`  would set image on ${stale} ${source} rows`);
  }
}

console.log(
  APPLY
    ? `Done — ${wrote} rows updated. The streamer picks the change up live (mp3_items NOTIFY → ListenMp3); tune the Radio Tuner to verify.`
    : "Dry run complete.",
);
