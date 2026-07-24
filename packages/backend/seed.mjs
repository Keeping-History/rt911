/**
 * bootstrap.mjs
 *
 * Creates the Directus schema and imports both datasets from scratch:
 *   1. entries_media.json  → media_items (TV / m3u8 broadcast records)
 *   2. entries_news.json   → media_items (news/history entries, dates parsed from titles)
 *
 * Usage:
 *   cp .env.example .env   # fill in values
 *   docker compose up -d
 *   node bootstrap.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIRECTUS_URL   = process.env.DIRECTUS_URL   ?? "http://localhost:8055";
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "changeme";
const DB_USER        = process.env.DB_USER        ?? "directus";
const DB_DATABASE    = process.env.DB_DATABASE    ?? "directus";

const MEDIA_DATA_PATH  = process.env.MEDIA_DATA_PATH  ?? join(__dirname, "entries_media.json");
const NEWS_DATA_PATH   = process.env.NEWS_DATA_PATH   ?? join(__dirname, "entries_news.json");
const PAGER_DATA_PATH  = process.env.PAGER_DATA_PATH  ?? join(__dirname, "pager_entries.json");

const NEWS_SOURCE_NAME       = "History Commons";
const DEFAULT_CALC_DURATION  = 300;  // 5 minutes in seconds
const FIVE_MINUTES_SECONDS   = 300;
const ONE_HOUR_SECONDS       = 3600;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function getToken() {
  const MAX_ATTEMPTS = 20;
  const RETRY_DELAY_MS = 10_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (res.ok) {
      const { data } = await res.json();
      return data.access_token;
    }
    const body = await res.text();
    if (res.status === 503 && attempt < MAX_ATTEMPTS) {
      console.log(`Directus not ready yet (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${RETRY_DELAY_MS / 1000}s…`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      continue;
    }
    throw new Error(`Login failed: ${body}`);
  }
}

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

function psql(sql) {
  const psqlUrl = process.env.PSQL_URL;
  if (psqlUrl) {
    const result = spawnSync("psql", [psqlUrl, "-v", "ON_ERROR_STOP=1"], {
      input: sql,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`psql failed:\n${result.stderr || result.stdout}`);
    }
    return;
  }
  const result = spawnSync(
    "docker",
    ["compose", "exec", "-T", "rt911-db", "psql", "-U", DB_USER, "-d", DB_DATABASE, "-v", "ON_ERROR_STOP=1"],
    { input: sql, cwd: __dirname, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed:\n${result.stderr || result.stdout}`);
  }
}

function sqlVal(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Schema setup
// ---------------------------------------------------------------------------

async function createCollections(token) {
  const existing = await api(token, "GET", "/collections");
  const names = existing.data.map((c) => c.collection);

  if (!names.includes("sources")) {
    console.log("Creating collection: sources");
    await api(token, "POST", "/collections", {
      collection: "sources",
      meta: { icon: "radio", note: "Sources / networks / newsgroups, classified by type" },
      schema: {},
      fields: [
        { field: "id",          type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true, readonly: true } },
        { field: "name",        type: "string",  schema: { is_nullable: false }, meta: { required: true, interface: "input", width: "half" } },
        { field: "slug",        type: "string",  schema: { is_nullable: false, is_unique: true }, meta: { required: true, interface: "input", width: "half" } },
        // type discriminates what kind of source a row is, so one table can back
        // every channel's filter: "video" (TV), "pager", "usenet" (newsgroup), …
        { field: "type",        type: "string",  schema: { is_nullable: true }, meta: { interface: "select-dropdown", width: "half", options: { choices: ["video", "pager", "usenet"].map((v) => ({ text: v, value: v })) } } },
        { field: "description", type: "text",    schema: {}, meta: { interface: "input-multiline" } },
      ],
    });
    // message_count is precomputed per source (used by usenet newsgroups — the
    // corpus is historical/immutable, so the count is stable). Integer added
    // individually (bulk endpoint creates string columns).
    await api(token, "POST", "/fields/sources", { field: "message_count", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half", readonly: true, note: "Precomputed item count (usenet)" } });
  } else {
    console.log("Collection sources already exists, skipping.");
    // Ensure the type/message_count columns exist on a pre-existing sources collection.
    const have = new Set((await api(token, "GET", "/fields/sources")).data.map((f) => f.field));
    if (!have.has("type")) {
      console.log("Adding field: sources.type");
      await api(token, "POST", "/fields/sources", { field: "type", type: "string", schema: { is_nullable: true }, meta: { interface: "select-dropdown", width: "half", options: { choices: ["video", "pager", "usenet"].map((v) => ({ text: v, value: v })) } } });
    }
    if (!have.has("message_count")) {
      console.log("Adding field: sources.message_count");
      await api(token, "POST", "/fields/sources", { field: "message_count", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half", readonly: true, note: "Precomputed item count (usenet)" } });
    }
  }

  // media_items and mp3_items share the same shape — mp3 reuses the MediaItem
  // model, it just lives in its own table and rides the opt-in "mp3" channel.
  const mediaLikeBaseFields = [
    { field: "id",            type: "integer",  schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true, readonly: true } },
    { field: "title",         type: "string",   schema: { is_nullable: false }, meta: { required: true, interface: "input", width: "half" } },
    { field: "full_title",    type: "string",   schema: {}, meta: { interface: "input", width: "half" } },
    { field: "start_date",    type: "dateTime", schema: { is_nullable: false }, meta: { required: true, interface: "datetime", width: "half" } },
    { field: "end_date",      type: "dateTime", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half" } },
    { field: "timezone",      type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
    { field: "url",           type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "full" } },
    { field: "format",        type: "string",   schema: { is_nullable: true }, meta: { interface: "select-dropdown", width: "half", options: { choices: ["m3u8", "mp4", "modal"].map((v) => ({ text: v.toUpperCase(), value: v })) } } },
    { field: "image",         type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
    { field: "image_caption", type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
    { field: "subtitles",     type: "text",     schema: { is_nullable: true }, meta: { interface: "input", width: "full", note: "Public URL to the .srt subtitle file" } },
    { field: "content",       type: "text",     schema: { is_nullable: true }, meta: { interface: "input-multiline" } },
  ];

  // Numeric fields added individually — the bulk collection endpoint silently creates
  // string columns instead of numeric ones when type is specified in the bulk payload.
  const numericFields = [
    { field: "source",        type: "integer", schema: { is_nullable: true },    meta: { interface: "select-dropdown-m2o", display: "related-values", width: "half" } },
    { field: "calc_duration", type: "integer", schema: { is_nullable: true },    meta: { interface: "input", width: "half", note: "Duration in seconds" } },
    { field: "approved",      type: "integer", schema: { default_value: 1 },     meta: { interface: "input", width: "half", note: "1 = approved, 0 = pending" } },
    { field: "mute",          type: "integer", schema: { default_value: 0 },     meta: { interface: "input", width: "half", note: "1 = muted, 0 = audible" } },
    { field: "volume",        type: "float",   schema: { default_value: 1 },     meta: { interface: "slider", width: "half", options: { min: 0, max: 1, step: 0.05 } } },
    { field: "jump",          type: "integer", schema: { default_value: 0 },     meta: { interface: "input", width: "half", note: "Playback start offset (seconds)" } },
    { field: "trim",          type: "integer", schema: { default_value: 0 },     meta: { interface: "input", width: "half", note: "Trim from end (seconds)" } },
    { field: "sort",          type: "integer", schema: { is_nullable: true },    meta: { interface: "input", hidden: true } },
  ];

  // Add the integer/float fields to a collection, skipping any that already exist.
  async function ensureNumericFields(collection) {
    const existing = await api(token, "GET", `/fields/${collection}`);
    const have = new Set(existing.data.map((f) => f.field));
    for (const fieldDef of numericFields) {
      if (have.has(fieldDef.field)) {
        console.log(`Field ${collection}.${fieldDef.field} already exists, skipping.`);
        continue;
      }
      console.log(`Creating field: ${collection}.${fieldDef.field}`);
      await api(token, "POST", `/fields/${collection}`, fieldDef);
    }
  }

  if (!names.includes("media_items")) {
    console.log("Creating collection: media_items");
    await api(token, "POST", "/collections", {
      collection: "media_items",
      meta: { icon: "movie", sort_field: "sort", note: "Scheduled broadcast media" },
      schema: {},
      fields: mediaLikeBaseFields,
    });
  } else {
    console.log("Collection media_items already exists, skipping.");
  }
  await ensureNumericFields("media_items");

  // mp3_items — Radio app audio lives in its own table (not media_items), same
  // shape as media_items, delivered on the opt-in "mp3" channel.
  if (!names.includes("mp3_items")) {
    console.log("Creating collection: mp3_items");
    await api(token, "POST", "/collections", {
      collection: "mp3_items",
      meta: { icon: "radio", sort_field: "sort", note: "Radio (mp3) audio streams" },
      schema: {},
      fields: mediaLikeBaseFields,
    });
  } else {
    console.log("Collection mp3_items already exists, skipping.");
  }
  await ensureNumericFields("mp3_items");

  // news_items — News app entries live in their own table (not media_items),
  // same shape as media_items, delivered on the opt-in "news" channel.
  if (!names.includes("news_items")) {
    console.log("Creating collection: news_items");
    await api(token, "POST", "/collections", {
      collection: "news_items",
      meta: { icon: "feed", sort_field: "sort", note: "News / history entries" },
      schema: {},
      fields: mediaLikeBaseFields,
    });
  } else {
    console.log("Collection news_items already exists, skipping.");
  }
  await ensureNumericFields("news_items");

  // tv_channels — the stitched continuous HLS channels (one row per channel,
  // each pointing at its playlists/<slug>/master.m3u8), same shape as media_items.
  // The TV app's main video channel reads from this table (the streamer's
  // selectFrom / media_items_changed listener point here), separating the 23
  // channel streams from media_items' per-program clips.
  if (!names.includes("tv_channels")) {
    console.log("Creating collection: tv_channels");
    await api(token, "POST", "/collections", {
      collection: "tv_channels",
      meta: { icon: "live_tv", sort_field: "sort", note: "Stitched continuous HLS channels" },
      schema: {},
      fields: mediaLikeBaseFields,
    });
  } else {
    console.log("Collection tv_channels already exists, skipping.");
  }
  await ensureNumericFields("tv_channels");

  // alert_items — media-shaped collection (same shape as tv_channels / tm_bookmarks):
  // a title/full_title + a start_date the desktop clock can seek to. Authored in the
  // Directus admin UI (ships empty on a fresh install). Like tm_bookmarks it is not
  // streamed, so — matching that precedent — its `source` field is left unlinked (no
  // sources relation). See seed note below re: public read if the frontend fetches it.
  if (!names.includes("alert_items")) {
    console.log("Creating collection: alert_items");
    await api(token, "POST", "/collections", {
      collection: "alert_items",
      meta: { icon: "warning", sort_field: "sort", note: "Alert timeline events" },
      schema: {},
      fields: mediaLikeBaseFields,
    });
    // Widen varchar(255) columns to text, matching the other media-shaped tables.
    widenMediaLikeColumns("alert_items");
  } else {
    console.log("Collection alert_items already exists, skipping.");
  }
  await ensureNumericFields("alert_items");

  // severity is alert-only (not in mediaLikeBaseFields): it selects the ClassicyAlert
  // icon (note/caution/stop) when alert_items is streamed on the "alerts" channel.
  // Idempotent add, matching the ensureNumericFields introspection idiom.
  {
    const alertFields = await api(token, "GET", "/fields/alert_items");
    const haveSeverity = new Set(alertFields.data.map((f) => f.field)).has("severity");
    if (!haveSeverity) {
      console.log("Adding field: alert_items.severity");
      await api(token, "POST", "/fields/alert_items", {
        field: "severity",
        type: "string",
        schema: { is_nullable: true, default_value: "note" },
        meta: {
          interface: "select-dropdown",
          width: "half",
          note: "Alert icon: note | caution | stop",
          options: { choices: ["note", "caution", "stop"].map((v) => ({ text: v, value: v })) },
        },
      });
    }
  }

  // tm_bookmarks — Time Machine "jump to a moment" bookmarks. Same media_items
  // shape as alert_items (a title/full_title + a start_date the desktop clock
  // seeks to). Read directly over Directus REST by the frontend Time Machine app
  // — not streamed — so createCollections also grants the public policy read
  // access to it (ensurePublicBookmarkAccess). Ships empty; rows are authored in
  // the Directus admin UI.
  if (!names.includes("tm_bookmarks")) {
    console.log("Creating collection: tm_bookmarks");
    await api(token, "POST", "/collections", {
      collection: "tm_bookmarks",
      meta: { icon: "bookmark", sort_field: "sort", note: "Time Machine bookmarks (jump-to timeline events)" },
      schema: {},
      fields: mediaLikeBaseFields,
    });
    // Widen varchar(255) columns to text so long event descriptions fit, matching
    // the other media-shaped tables. Done in the fresh-create branch only.
    widenMediaLikeColumns("tm_bookmarks");
  } else {
    console.log("Collection tm_bookmarks already exists, skipping.");
  }
  await ensureNumericFields("tm_bookmarks");

  // ---- IM Buddies (see plans/2026-07-24-im-buddies-chatbot-design.md) ----
  // Nine collections: one settings singleton, four configuration tables, three
  // knowledge tiers (chat_knowledge + chat_transcript_segments; news_items is
  // tier 3 and already exists), and two per-user state tables.

  if (!names.includes("chat_settings")) {
    console.log("Creating collection: chat_settings");
    await api(token, "POST", "/collections", {
      collection: "chat_settings",
      meta: { icon: "settings", singleton: true, note: "Global LLM defaults for IM Buddies" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "provider", type: "string", schema: { is_nullable: false, default_value: "anthropic" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["anthropic", "openai", "openrouter"].map((v) => ({ text: v, value: v })) } } },
        { field: "model", type: "string", schema: { is_nullable: false, default_value: "claude-opus-5" }, meta: { interface: "input", width: "half" } },
        { field: "max_tokens", type: "integer", schema: { is_nullable: false, default_value: 2000 }, meta: { interface: "input", width: "half" } },
        { field: "effort", type: "string", schema: { is_nullable: true, default_value: "low" }, meta: { interface: "input", width: "half" } },
        { field: "temperature", type: "float", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Ignored on Anthropic (Opus 5 rejects it)" } },
        { field: "openai_base_url", type: "text", schema: { is_nullable: true }, meta: { interface: "input", width: "full", note: "OpenRouter: https://openrouter.ai/api/v1" } },
      ],
    });
  } else {
    console.log("Collection chat_settings already exists, skipping.");
  }

  if (!names.includes("chat_profiles")) {
    console.log("Creating collection: chat_profiles");
    await api(token, "POST", "/collections", {
      collection: "chat_profiles",
      meta: { icon: "person", sort_field: "sort", note: "IM buddy personas" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "screen_name", type: "string", schema: { is_nullable: false }, meta: { interface: "input", width: "half" } },
        { field: "display_name", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "avatar", type: "text", schema: { is_nullable: true }, meta: { interface: "input", width: "full" } },
        { field: "persona", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "education_level", type: "string", schema: { is_nullable: true },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["elementary", "middle", "high", "college", "adult"].map((v) => ({ text: v, value: v })) } } },
        { field: "writing_style", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "style_exemplars", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full", note: "A few sample messages in voice, one per line" } },
        { field: "location", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "timezone", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "online_from", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half" } },
        { field: "online_until", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half" } },
        { field: "typing_speed", type: "integer", schema: { is_nullable: true, default_value: 5 }, meta: { interface: "input", width: "half", note: "Characters per second; sets the reply-delay floor" } },
        { field: "system_prompt_extra", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "provider", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "model", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "max_tokens", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "effort", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "temperature", type: "float", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Null inherits chat_settings" } },
        { field: "active", type: "integer", schema: { is_nullable: false, default_value: 1 }, meta: { interface: "boolean", width: "half" } },
        { field: "sort", type: "integer", schema: { is_nullable: true }, meta: { hidden: true } },
      ],
    });
  } else {
    console.log("Collection chat_profiles already exists, skipping.");
  }

  if (!names.includes("chat_beacons")) {
    console.log("Creating collection: chat_beacons");
    await api(token, "POST", "/collections", {
      collection: "chat_beacons",
      meta: { icon: "flag", note: "Named story anchors. `at` = when it happened, `public_at` = when it became publicly known" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "key", type: "string", schema: { is_nullable: false, is_unique: true }, meta: { interface: "input", width: "half" } },
        { field: "label", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half" } },
        { field: "public_at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half", note: "Phases advance on this, never on `at`" } },
        { field: "description", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
      ],
    });
  } else {
    console.log("Collection chat_beacons already exists, skipping.");
  }

  if (!names.includes("chat_phases")) {
    console.log("Creating collection: chat_phases");
    await api(token, "POST", "/collections", {
      collection: "chat_phases",
      meta: { icon: "mood", sort_field: "sort", note: "Per-profile emotional arc, anchored to beacons" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "profile", type: "integer", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "from_beacon", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half", note: "Null = start of day" } },
        { field: "tone", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "shock", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "coherence", type: "integer", schema: { is_nullable: false, default_value: 100 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "verbosity", type: "integer", schema: { is_nullable: false, default_value: 50 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "typo_rate", type: "integer", schema: { is_nullable: false, default_value: 10 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "topic_focus", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { interface: "slider", width: "half", options: { minValue: 0, maxValue: 100 } } },
        { field: "sort", type: "integer", schema: { is_nullable: true }, meta: { hidden: true } },
      ],
    });
  } else {
    console.log("Collection chat_phases already exists, skipping.");
  }

  if (!names.includes("chat_schedules")) {
    console.log("Creating collection: chat_schedules");
    await api(token, "POST", "/collections", {
      collection: "chat_schedules",
      meta: { icon: "schedule", note: "Proactive messages. Beacon-relative is the primary form; `at` overrides" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "profile", type: "integer", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "at_beacon", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "offset_seconds", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { interface: "input", width: "half" } },
        { field: "at", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half", note: "Absolute override; wins over at_beacon" } },
        { field: "kind", type: "string", schema: { is_nullable: false, default_value: "generated" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["static", "generated"].map((v) => ({ text: v, value: v })) } } },
        { field: "text", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full", note: "kind=static" } },
        { field: "prompt", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full", note: "kind=generated" } },
        { field: "requires_prior_contact", type: "integer", schema: { is_nullable: false, default_value: 0 }, meta: { interface: "boolean", width: "half" } },
        { field: "active", type: "integer", schema: { is_nullable: false, default_value: 1 }, meta: { interface: "boolean", width: "half" } },
      ],
    });
  } else {
    console.log("Collection chat_schedules already exists, skipping.");
  }

  if (!names.includes("chat_knowledge")) {
    console.log("Creating collection: chat_knowledge");
    await api(token, "POST", "/collections", {
      collection: "chat_knowledge",
      meta: { icon: "fact_check", note: "Tier 1 — curated public-knowledge timeline" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "public_at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half" } },
        { field: "until", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half", note: "When this stopped being current or was corrected" } },
        { field: "summary", type: "text", schema: { is_nullable: false }, meta: { interface: "input-multiline", width: "full" } },
        { field: "detail", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "certainty", type: "string", schema: { is_nullable: false, default_value: "reported" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["rumor", "reported", "confirmed"].map((v) => ({ text: v, value: v })) } } },
        { field: "sensitivity", type: "string", schema: { is_nullable: false, default_value: "normal" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["normal", "handle_with_care", "do_not_discuss"].map((v) => ({ text: v, value: v })) } } },
        { field: "topics", type: "text", schema: { is_nullable: true }, meta: { interface: "input", width: "full", note: "Comma-separated" } },
      ],
    });
  } else {
    console.log("Collection chat_knowledge already exists, skipping.");
  }

  if (!names.includes("chat_transcript_segments")) {
    console.log("Creating collection: chat_transcript_segments");
    await api(token, "POST", "/collections", {
      collection: "chat_transcript_segments",
      meta: { icon: "closed_caption", note: "Tier 2 — broadcast transcript segments, produced by video-grabber" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "channel", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "channel_slug", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Used for radio, which has no tv_channels row" } },
        { field: "medium", type: "string", schema: { is_nullable: false, default_value: "tv" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["tv", "radio"].map((v) => ({ text: v, value: v })) } } },
        { field: "start_date", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half" } },
        { field: "end_date", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half" } },
        { field: "text", type: "text", schema: { is_nullable: false }, meta: { interface: "input-multiline", width: "full" } },
      ],
    });
  } else {
    console.log("Collection chat_transcript_segments already exists, skipping.");
  }

  if (!names.includes("chat_messages")) {
    console.log("Creating collection: chat_messages");
    await api(token, "POST", "/collections", {
      collection: "chat_messages",
      meta: { icon: "chat", note: "Per-user conversation log. Directus policy MUST scope this to $CURRENT_USER" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "user", type: "uuid", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "profile", type: "integer", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "direction", type: "string", schema: { is_nullable: false },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["in", "out"].map((v) => ({ text: v, value: v })) } } },
        { field: "body", type: "text", schema: { is_nullable: false }, meta: { interface: "input-multiline", width: "full" } },
        { field: "virtual_time", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half", note: "Position on the 2001 clock" } },
        { field: "created_at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half", note: "Real wall-clock time" } },
        { field: "kind", type: "string", schema: { is_nullable: false, default_value: "typed" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["typed", "scheduled", "generated", "static", "stall"].map((v) => ({ text: v, value: v })) } } },
        { field: "moderation", type: "json", schema: { is_nullable: true }, meta: { interface: "input-code", width: "full", special: ["cast-json"] } },
        { field: "model", type: "string", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "tokens_in", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "tokens_out", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
      ],
    });
  } else {
    console.log("Collection chat_messages already exists, skipping.");
  }

  if (!names.includes("chat_blocks")) {
    console.log("Creating collection: chat_blocks");
    await api(token, "POST", "/collections", {
      collection: "chat_blocks",
      meta: { icon: "block", note: "Moderation blocks. Directus policy MUST scope this to $CURRENT_USER" },
      schema: {},
      fields: [
        { field: "id", type: "integer", schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true } },
        { field: "user", type: "uuid", schema: { is_nullable: false }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "scope", type: "string", schema: { is_nullable: false, default_value: "profile" },
          meta: { interface: "select-dropdown", width: "half",
                  options: { choices: ["profile", "global"].map((v) => ({ text: v, value: v })) } } },
        { field: "profile", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", width: "half" } },
        { field: "reason", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "evidence", type: "text", schema: { is_nullable: true }, meta: { interface: "input-multiline", width: "full" } },
        { field: "created_at", type: "timestamp", schema: { is_nullable: false }, meta: { interface: "datetime", width: "half" } },
        { field: "expires", type: "timestamp", schema: { is_nullable: true }, meta: { interface: "datetime", width: "half", note: "Null = permanent" } },
      ],
    });
  } else {
    console.log("Collection chat_blocks already exists, skipping.");
  }

  // pager_items — pager traffic lives in its own table (not media_items). Every
  // pager item is "instant": a start_date with no duration/end_date. provider is
  // a plain text column, not a sources FK.
  if (!names.includes("pager_items")) {
    console.log("Creating collection: pager_items");
    await api(token, "POST", "/collections", {
      collection: "pager_items",
      meta: { icon: "pager", sort_field: "sort", note: "Historical pager messages" },
      schema: {},
      fields: [
        { field: "id",           type: "integer",  schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true, readonly: true } },
        { field: "start_date",   type: "dateTime", schema: { is_nullable: false }, meta: { required: true, interface: "datetime", width: "half" } },
        { field: "provider",     type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "recipient_id", type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "id_type",      type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "channel",      type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "mode",         type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half" } },
        { field: "message",      type: "text",     schema: { is_nullable: true }, meta: { interface: "input-multiline" } },
      ],
    });

    // approved as integer (1/0) added individually — the bulk endpoint creates
    // string columns when type is in the bulk payload (same caveat as media_items).
    await api(token, "POST", "/fields/pager_items", { field: "approved", type: "integer", schema: { default_value: 1 }, meta: { interface: "input", width: "half", note: "1 = approved, 0 = pending" } });
    await api(token, "POST", "/fields/pager_items", { field: "sort", type: "integer", schema: { is_nullable: true }, meta: { interface: "input", hidden: true } });
    // source FK into sources (type="pager"), backfilled from provider by
    // migratePagerSources. provider is kept as the import field + audit trail.
    await api(token, "POST", "/fields/pager_items", { field: "source", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", display: "related-values", width: "half", note: "Provider (sources row, type=pager)" } });
  } else {
    console.log("Collection pager_items already exists, skipping.");
    // Ensure the source FK exists on a pre-existing pager_items (migration).
    const have = new Set((await api(token, "GET", "/fields/pager_items")).data.map((f) => f.field));
    if (!have.has("source")) {
      console.log("Adding field: pager_items.source");
      await api(token, "POST", "/fields/pager_items", { field: "source", type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", display: "related-values", width: "half", note: "Provider (sources row, type=pager)" } });
    }
  }

  // usenet_items — Usenet messages, one row per post. Like pager_items, each post
  // is "instant": a start_date (the posting time, the streamer's schedule key) with
  // no duration/end_date. The newsgroup is NOT stored inline — it is a row in the
  // shared sources table (type="usenet") that usenet_items.source references, the
  // same way media_items/news_items/mp3_items link their source. message_id is NOT
  // unique (crossposts repeat it). references/in_reply_to are kept raw so threading
  // can be derived; thread_id/parent_id are populated by the threading stage
  // (usenetarchive). See plans/usenet-archive-ingestion.md for the producer.
  if (!names.includes("usenet_items")) {
    console.log("Creating collection: usenet_items");
    await api(token, "POST", "/collections", {
      collection: "usenet_items",
      meta: { icon: "article", sort_field: "sort", note: "Usenet messages" },
      schema: {},
      fields: [
        { field: "id",           type: "integer",  schema: { is_primary_key: true, has_auto_increment: true }, meta: { hidden: true, readonly: true } },
        { field: "start_date",   type: "dateTime", schema: { is_nullable: false }, meta: { required: true, interface: "datetime", width: "half", note: "Posting time (UTC); the streamer's schedule key" } },
        { field: "subject",      type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "full" } },
        { field: "author",       type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "From header (name + email)" } },
        { field: "message_id",   type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Message-ID (not unique: crossposts repeat)" } },
        { field: "references",   type: "text",     schema: { is_nullable: true }, meta: { interface: "input-multiline", note: "Raw References header (thread ancestry)" } },
        { field: "in_reply_to",  type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "In-Reply-To (parent message-id)" } },
        { field: "thread_id",    type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Set by threading stage; null until then" } },
        { field: "parent_id",    type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Parent message-id within thread" } },
        { field: "body",         type: "text",     schema: { is_nullable: true }, meta: { interface: "input-multiline" } },
        { field: "date_source",  type: "string",   schema: { is_nullable: true }, meta: { interface: "input", width: "half", note: "Header the start_date came from (QA)" } },
      ],
    });
    // Integer columns added individually (bulk endpoint creates strings). source
    // is the FK into sources (type="usenet"); the relation is wired in createRelations.
    await api(token, "POST", "/fields/usenet_items", { field: "source",   type: "integer", schema: { is_nullable: true }, meta: { interface: "select-dropdown-m2o", display: "related-values", width: "half", note: "Newsgroup (sources row, type=usenet)" } });
    await api(token, "POST", "/fields/usenet_items", { field: "approved", type: "integer", schema: { default_value: 1 }, meta: { interface: "input", width: "half", note: "1 = approved, 0 = pending" } });
    await api(token, "POST", "/fields/usenet_items", { field: "sort",     type: "integer", schema: { is_nullable: true }, meta: { interface: "input", hidden: true } });

    // Widen text columns (Directus makes varchar(255), too short for some From/
    // Message-ID/subject headers) and index the per-group time lookups the streamer
    // does — the usenet channel reads Postgres directly (no Redis cache), so this
    // (source, start_date) index is what keeps CurrentUsenetItems/UsenetItemsInRange
    // fast. Done in the fresh-create branch so it never rewrites a populated table.
    psql(`
      ALTER TABLE usenet_items
        ALTER COLUMN subject     TYPE text,
        ALTER COLUMN author      TYPE text,
        ALTER COLUMN message_id  TYPE text,
        ALTER COLUMN in_reply_to TYPE text,
        ALTER COLUMN thread_id   TYPE text,
        ALTER COLUMN parent_id   TYPE text,
        ALTER COLUMN date_source TYPE text;
      CREATE INDEX IF NOT EXISTS idx_usenet_items_source_start
        ON usenet_items (source, start_date);
    `);
  } else {
    console.log("Collection usenet_items already exists, skipping.");
  }
}

// The frontend Time Machine app fetches tm_bookmarks anonymously (no token), so
// the Directus public policy needs read access to it. Directus Community only
// supports full (all-or-nothing) access rules — no field/filter restrictions —
// so this grants read on all fields, which is fine for non-sensitive event
// bookmarks. Idempotent: skips if the grant already exists.
async function ensurePublicBookmarkAccess(token) {
  const policies = await api(token, "GET", "/policies?fields=id,name&limit=-1");
  const publicPolicy = policies.data.find((p) => p.name === "$t:public_label");
  if (!publicPolicy) {
    console.warn("Public policy not found — skipping tm_bookmarks public read grant.");
    return;
  }
  const existing = await api(
    token,
    "GET",
    `/permissions?filter[policy][_eq]=${publicPolicy.id}&filter[collection][_eq]=tm_bookmarks&filter[action][_eq]=read`,
  );
  if (existing.data.length > 0) {
    console.log("Public read on tm_bookmarks already granted, skipping.");
    return;
  }
  console.log("Granting public read on tm_bookmarks");
  await api(token, "POST", "/permissions", {
    policy: publicPolicy.id,
    collection: "tm_bookmarks",
    action: "read",
    fields: ["*"],
  });
}

// createStreamerIndexes indexes the per-table time lookups the streamer's init/seek
// queries run. usenet already has its own (source, start_date) index (see
// createCollections); the video/news/mp3/pager tables are filtered by
// (approved, start_date) on every Current*Items call, which without an index is a
// sequential scan — invisible at low traffic, a bottleneck under a connection burst.
// Run unconditionally (not just in the fresh-create branch) so existing, already
// populated tables get the index too; IF NOT EXISTS makes re-runs a no-op. These
// tables are small and write-rarely (historical data), so a plain CREATE INDEX's
// brief lock is fine — switch to CREATE INDEX CONCURRENTLY if that ever changes.
function createStreamerIndexes() {
  console.log("Ensuring streamer (approved, start_date) indexes…");
  psql(`
    CREATE INDEX IF NOT EXISTS idx_tv_channels_approved_start ON tv_channels (approved, start_date);
    CREATE INDEX IF NOT EXISTS idx_news_items_approved_start  ON news_items  (approved, start_date);
    CREATE INDEX IF NOT EXISTS idx_mp3_items_approved_start   ON mp3_items   (approved, start_date);
    CREATE INDEX IF NOT EXISTS idx_pager_items_approved_start ON pager_items (approved, start_date);
    CREATE INDEX IF NOT EXISTS idx_chat_knowledge_public   ON chat_knowledge (public_at);
    CREATE INDEX IF NOT EXISTS idx_chat_transcript_start   ON chat_transcript_segments (start_date);
    CREATE INDEX IF NOT EXISTS idx_chat_transcript_fts     ON chat_transcript_segments USING GIN (to_tsvector('english', text));
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user_conv ON chat_messages (( "user" ), profile, virtual_time);
    CREATE INDEX IF NOT EXISTS idx_chat_blocks_user        ON chat_blocks (( "user" ), scope);
    CREATE INDEX IF NOT EXISTS idx_chat_schedules_profile  ON chat_schedules (profile, active);
    CREATE INDEX IF NOT EXISTS idx_chat_phases_profile     ON chat_phases (profile, sort);
  `);
}

async function createRelations(token) {
  const existing = await api(token, "GET", "/relations");
  for (const collection of ["media_items", "mp3_items", "news_items", "tv_channels", "usenet_items", "pager_items"]) {
    const alreadyLinked = existing.data.some(
      (r) => r.collection === collection && r.field === "source",
    );
    if (alreadyLinked) {
      console.log(`Relation ${collection}.source → sources already exists, skipping.`);
      continue;
    }
    console.log(`Creating relation: ${collection}.source → sources.id`);
    await api(token, "POST", "/relations", {
      collection,
      field: "source",
      related_collection: "sources",
      schema: { on_delete: "SET NULL" },
      meta: { one_collection: "sources", one_field: null, sort_field: null },
    });
  }
}

// ---------------------------------------------------------------------------
// TV / media import  (entries_media.json)
// ---------------------------------------------------------------------------

async function importSources(token, records) {
  const slugs = [...new Set(records.map((r) => r.source))];
  const existing = await api(token, "GET", "/items/sources?limit=-1&fields=slug");
  const existingSlugs = new Set(existing.data.map((s) => s.slug));

  const toCreate = slugs
    .filter((s) => s && !existingSlugs.has(s))
    .map((s) => ({ name: s, slug: s, type: "video" }));

  if (toCreate.length === 0) {
    console.log("All sources already exist, skipping.");
  } else {
    console.log(`Importing ${toCreate.length} sources…`);
    await api(token, "POST", "/items/sources", toCreate);
  }

  const all = await api(token, "GET", "/items/sources?limit=-1&fields=id,slug");
  return Object.fromEntries(all.data.map((s) => [s.slug, s.id]));
}

const MEDIA_LIKE_COLS = `title,full_title,source,start_date,end_date,calc_duration,timezone,url,format,approved,mute,volume,jump,"trim",image,image_caption,subtitles,content,sort`;

// Widen varchar columns — Directus creates string fields as varchar(255) which is
// too short for content/url/etc. Applies to any media-shaped table.
function widenMediaLikeColumns(table) {
  psql(`
    ALTER TABLE ${table}
      ALTER COLUMN title          TYPE text,
      ALTER COLUMN full_title     TYPE text,
      ALTER COLUMN timezone       TYPE text,
      ALTER COLUMN url            TYPE text,
      ALTER COLUMN format         TYPE text,
      ALTER COLUMN image          TYPE text,
      ALTER COLUMN image_caption  TYPE text,
      ALTER COLUMN subtitles      TYPE text,
      ALTER COLUMN content        TYPE text;
  `);
}

// Insert media-shaped records into the given table in batches.
function insertMediaLikeRecords(table, records, sourceMap) {
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    process.stdout.write(`  ${i + 1}–${Math.min(i + BATCH, records.length)} / ${records.length}\r`);
    const batch = records.slice(i, i + BATCH);
    const rows = batch.map((r) => `(${[
      sqlVal(r.title?.trim()),
      sqlVal(r.full_title?.trim()),
      sqlVal(sourceMap[r.source] ?? null),
      sqlVal(r.start_date),
      sqlVal(r.end_date),
      sqlVal(r.calc_duration),
      sqlVal(r.timezone),
      sqlVal(r.url),
      sqlVal(r.format),
      sqlVal(r.approved),
      sqlVal(r.mute),
      sqlVal(r.volume),
      sqlVal(r.jump),
      sqlVal(r.trim),
      sqlVal(r.image || null),
      sqlVal(r.image_caption || null),
      sqlVal(r.subtitles || null),
      sqlVal(r.content || null),
      sqlVal(r.sort),
    ].join(",")})`).join(",\n");

    psql(`INSERT INTO ${table} (${MEDIA_LIKE_COLS}) VALUES\n${rows};\n`);
  }
  console.log("\nDone.");
}

async function importMediaItems(token, records, sourceMap) {
  const existing = await api(token, "GET", "/items/media_items?limit=1&fields=id");
  if (existing.data.length > 0) {
    console.log("media_items already has records, skipping TV import.");
    return;
  }
  // mp3 lives in its own table/channel; html entries are duplicates of news
  // items (same History Commons articles) — keep both out of media_items.
  const EXCLUDED = new Set(["mp3", "html"]);
  const tvOnly = records.filter((r) => !EXCLUDED.has(r.format));
  widenMediaLikeColumns("media_items");
  console.log(`Importing ${tvOnly.length} TV media items (excluding mp3 + html) in batches of 500…`);
  insertMediaLikeRecords("media_items", tvOnly, sourceMap);
}

async function importMp3Items(token, records, sourceMap) {
  const existing = await api(token, "GET", "/items/mp3_items?limit=1&fields=id");
  if (existing.data.length > 0) {
    console.log("mp3_items already has records, skipping mp3 import.");
    return;
  }
  const mp3 = records.filter((r) => r.format === "mp3");
  widenMediaLikeColumns("mp3_items");
  console.log(`Importing ${mp3.length} mp3 items in batches of 500…`);
  insertMediaLikeRecords("mp3_items", mp3, sourceMap);
}

// ---------------------------------------------------------------------------
// News date/time parsing  (entries_news.json)
// ---------------------------------------------------------------------------

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseMonthName(name) {
  return MONTH_NAMES[name.toLowerCase()] ?? null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDatetime(year, month = 1, day = 1, hour = 0, minute = 0, second = 0) {
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

function parseClockTime(str) {
  const m = str.match(/(\d+):(\d+)\s*(a\.m\.|p\.m\.|am|pm)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const period = m[3].replace(/\./g, "").toLowerCase();
  if (period === "pm" && hour !== 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

const MONTH_PAT = `(?:January|February|March|April|May|June|July|August|September|October|November|December)`;
const TIME_PAT  = `\\d+:\\d+\\s*(?:a\\.m\\.|p\\.m\\.|am|pm)`;

function parseTitleDate(title) {
  let m;

  // 1. (Time-Time) Month Day, Year
  m = title.match(new RegExp(`\\((${TIME_PAT})-(${TIME_PAT})\\)\\s*(${MONTH_PAT})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"));
  if (m) {
    const t1 = parseClockTime(m[1]), t2 = parseClockTime(m[2]);
    const month = parseMonthName(m[3]), day = parseInt(m[4], 10), year = parseInt(m[5], 10);
    if (t1 && t2 && month) {
      return {
        startDate: formatDatetime(year, month, day, t1.hour, t1.minute),
        parsedEndDate: formatDatetime(year, month, day, t2.hour, t2.minute),
        durationSeconds: (t2.hour * 60 + t2.minute - (t1.hour * 60 + t1.minute)) * 60,
      };
    }
  }

  // 2. (Between Time and Time) Month Day, Year
  m = title.match(new RegExp(`\\(Between\\s+(${TIME_PAT})\\s+and\\s+(${TIME_PAT})\\)\\s*(${MONTH_PAT})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"));
  if (m) {
    const t1 = parseClockTime(m[1]), t2 = parseClockTime(m[2]);
    const month = parseMonthName(m[3]), day = parseInt(m[4], 10), year = parseInt(m[5], 10);
    if (t1 && t2 && month) {
      return {
        startDate: formatDatetime(year, month, day, t1.hour, t1.minute),
        parsedEndDate: formatDatetime(year, month, day, t2.hour, t2.minute),
        durationSeconds: (t2.hour * 60 + t2.minute - (t1.hour * 60 + t1.minute)) * 60,
      };
    }
  }

  // 3. (Time) Month Day, Year
  m = title.match(new RegExp(`\\((${TIME_PAT})\\)\\s*(${MONTH_PAT})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"));
  if (m) {
    const t = parseClockTime(m[1]), month = parseMonthName(m[2]);
    const day = parseInt(m[3], 10), year = parseInt(m[4], 10);
    if (t && month) {
      return { startDate: formatDatetime(year, month, day, t.hour, t.minute), parsedEndDate: null, durationSeconds: null };
    }
  }

  // 4. Time Month Day, Year (no parens)
  m = title.match(new RegExp(`^[^:]*?(${TIME_PAT})\\s*(${MONTH_PAT})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"));
  if (m) {
    const t = parseClockTime(m[1]), month = parseMonthName(m[2]);
    const day = parseInt(m[3], 10), year = parseInt(m[4], 10);
    if (t && month) {
      return { startDate: formatDatetime(year, month, day, t.hour, t.minute), parsedEndDate: null, durationSeconds: null };
    }
  }

  // 5. Month Day, Year
  m = title.match(new RegExp(`(${MONTH_PAT})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"));
  if (m) {
    const month = parseMonthName(m[1]), day = parseInt(m[2], 10), year = parseInt(m[3], 10);
    if (month) return { startDate: formatDatetime(year, month, day), parsedEndDate: null, durationSeconds: null };
  }

  // 6. Month Year (no day)
  m = title.match(new RegExp(`(${MONTH_PAT})\\s+(\\d{4})`, "i"));
  if (m) {
    const month = parseMonthName(m[1]), year = parseInt(m[2], 10);
    if (month) return { startDate: formatDatetime(year, month, 1), parsedEndDate: null, durationSeconds: null };
  }

  // 7. Year-Year range — use start year
  m = title.match(/(\d{4})-(\d{4})/);
  if (m) return { startDate: formatDatetime(parseInt(m[1], 10)), parsedEndDate: null, durationSeconds: null };

  // 8. Bare four-digit year
  m = title.match(/\b(\d{4})\b/);
  if (m) return { startDate: formatDatetime(parseInt(m[1], 10)), parsedEndDate: null, durationSeconds: null };

  // 9. Decade notation e.g. "Early 1980s", "Mid-1980s"
  m = title.match(/\b(\d{3})0s\b/);
  if (m) return { startDate: formatDatetime(parseInt(m[1] + "0", 10)), parsedEndDate: null, durationSeconds: null };

  return { startDate: null, parsedEndDate: null, durationSeconds: null };
}

function transformNewsEntry(entry, sort, sourceId) {
  let { startDate, parsedEndDate, durationSeconds } = parseTitleDate(entry.title ?? "");

  // Clock times parsed from titles are Eastern (EDT for the 9/11-era data); store
  // UTC like every other stream. Date-only entries (midnight) carry no real
  // time-of-day, so they stay naive — only convert when a time was parsed.
  if (startDate && !startDate.endsWith(" 00:00:00")) startDate = etToUtc(startDate);
  if (parsedEndDate && !parsedEndDate.endsWith(" 00:00:00")) parsedEndDate = etToUtc(parsedEndDate);

  const calcDuration =
    durationSeconds !== null && durationSeconds > 0 && durationSeconds < ONE_HOUR_SECONDS
      ? durationSeconds
      : DEFAULT_CALC_DURATION;

  const endDate = calcDuration > FIVE_MINUTES_SECONDS ? startDate : (parsedEndDate ?? startDate);

  return {
    title:         (entry.title ?? "").trim(),
    full_title:    (entry.full_title ?? "").trim(),
    source:        sourceId,
    start_date:    startDate,
    end_date:      endDate,
    calc_duration: calcDuration,
    timezone:      entry.tz ?? null,
    url:           entry.url ?? null,
    format:        "news",
    approved:      1,
    mute:          0,
    volume:        1,
    jump:          0,
    trim:          0,
    image:         entry.image || null,
    image_caption: entry.image_caption || null,
    content:       entry.content || null,
    sort,
  };
}

async function resolveNewsSource(token) {
  const existing = await api(token, "GET", "/items/sources?limit=-1&fields=id,slug");
  const found = existing.data.find((s) => s.slug === NEWS_SOURCE_NAME);
  if (found) {
    console.log(`Source "${NEWS_SOURCE_NAME}" already exists (id=${found.id}).`);
    return found.id;
  }
  console.log(`Creating source "${NEWS_SOURCE_NAME}"…`);
  const created = await api(token, "POST", "/items/sources", [{ name: NEWS_SOURCE_NAME, slug: NEWS_SOURCE_NAME }]);
  return created.data[0].id;
}

async function importNewsItems(token, records, sourceId) {
  const existing = await api(token, "GET", "/items/news_items?limit=1&fields=id");
  if (existing.data.length > 0) {
    console.log("news_items already has records, skipping news import.");
    return;
  }

  widenMediaLikeColumns("news_items");

  const existingSort = await api(token, "GET", "/items/news_items?limit=1&sort[]=-sort&fields[]=sort");
  const maxSort = existingSort.data?.[0]?.sort ?? 0;

  const cols = MEDIA_LIKE_COLS;
  const BATCH = 500;

  const transformed = records.map((entry, i) => transformNewsEntry(entry, maxSort + i + 1, sourceId));

  let skipped = 0;
  const valid = transformed.filter((r) => {
    if (!r.start_date) { skipped++; return false; }
    return true;
  });

  if (skipped > 0) console.warn(`Warning: ${skipped} news entries skipped — no parseable date in title.`);
  console.log(`Importing ${valid.length} news items in batches of ${BATCH}…`);

  for (let i = 0; i < valid.length; i += BATCH) {
    process.stdout.write(`  ${i + 1}–${Math.min(i + BATCH, valid.length)} / ${valid.length}\r`);
    const batch = valid.slice(i, i + BATCH);
    const rows = batch.map((r) => `(${[
      sqlVal(r.title),
      sqlVal(r.full_title),
      sqlVal(r.source),
      sqlVal(r.start_date),
      sqlVal(r.end_date),
      sqlVal(r.calc_duration),
      sqlVal(r.timezone),
      sqlVal(r.url),
      sqlVal(r.format),
      sqlVal(r.approved),
      sqlVal(r.mute),
      sqlVal(r.volume),
      sqlVal(r.jump),
      sqlVal(r.trim),
      sqlVal(r.image),
      sqlVal(r.image_caption),
      sqlVal(r.subtitles),
      sqlVal(r.content),
      sqlVal(r.sort),
    ].join(",")})`).join(",\n");

    psql(`INSERT INTO news_items (${cols}) VALUES\n${rows};\n`);
  }

  console.log("\nDone.");
}

// ---------------------------------------------------------------------------
// Pager import  (pager_entries.json)
// ---------------------------------------------------------------------------

/**
 * Convert an Eastern Daylight Time timestamp string ("YYYY-MM-DD HH:MM:SS")
 * to a UTC timestamp string. All pager data is from 2001-09-11, which was in
 * EDT (UTC-4).
 */
function etToUtc(etTimestamp) {
  const [datePart, timePart] = etTimestamp.split(" ");
  const dt = new Date(`${datePart}T${timePart}-04:00`);
  const y  = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d  = String(dt.getUTCDate()).padStart(2, "0");
  const h  = String(dt.getUTCHours()).padStart(2, "0");
  const mi = String(dt.getUTCMinutes()).padStart(2, "0");
  const s  = String(dt.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

async function importPagerItems(token, records) {
  const existing = await api(token, "GET", "/items/pager_items?limit=1&fields=id");
  if (existing.data.length > 0) {
    console.log("pager_items already has records, skipping pager import.");
    return;
  }

  // Widen text columns — Directus creates string fields as varchar(255), too
  // short for long pager messages.
  psql(`
    ALTER TABLE pager_items
      ALTER COLUMN provider     TYPE text,
      ALTER COLUMN recipient_id TYPE text,
      ALTER COLUMN id_type      TYPE text,
      ALTER COLUMN channel      TYPE text,
      ALTER COLUMN mode         TYPE text,
      ALTER COLUMN message      TYPE text;
  `);

  const cols = `start_date,provider,recipient_id,id_type,channel,mode,message,approved,sort`;
  const BATCH = 500;

  // Sort by timestamp for correct ordering; drop records with no message content.
  const valid  = records.filter((r) => r.message && r.message.trim() !== "");
  const sorted = [...valid].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (valid.length !== records.length) {
    console.warn(`Warning: ${records.length - valid.length} pager records skipped — empty message.`);
  }
  console.log(`Importing ${sorted.length} pager items in batches of ${BATCH}…`);

  for (let i = 0; i < sorted.length; i += BATCH) {
    process.stdout.write(`  ${i + 1}–${Math.min(i + BATCH, sorted.length)} / ${sorted.length}\r`);
    const batch = sorted.slice(i, i + BATCH);
    const rows = batch.map((r, idx) => {
      const utcTs = etToUtc(r.timestamp);   // pager data is EDT; store UTC like media
      return `(${[
        sqlVal(utcTs),
        sqlVal(r.provider     ?? null),
        sqlVal(r.recipient_id ?? null),
        sqlVal(r.id_type      ?? null),
        sqlVal(r.channel      ?? null),
        sqlVal(r.mode         ?? null),
        sqlVal(r.message),
        sqlVal(1),
        sqlVal(i + idx + 1),
      ].join(",")})`;
    }).join(",\n");

    psql(`INSERT INTO pager_items (${cols}) VALUES\n${rows};\n`);
  }

  console.log("\nDone.");
}

// migratePagerSources backfills pager_items.source from the legacy provider text
// column: it creates one sources row (type="pager") per distinct provider and
// points each pager_items.source at it. Idempotent — safe on fresh installs (run
// after the import) and on already-deployed data. The provider column is left in
// place as the import field + audit trail; the backend now reads the provider via
// the source join (db.AvailablePagerProviders / pagerSelectFrom).
async function migratePagerSources(token) {
  // The relation/field must exist first; createCollections + createRelations handle
  // that. Only attempt the data backfill if the table actually has the columns.
  const fields = new Set((await api(token, "GET", "/fields/pager_items")).data.map((f) => f.field));
  if (!fields.has("source") || !fields.has("provider")) {
    console.log("pager_items missing source/provider column, skipping pager source backfill.");
    return;
  }
  console.log("Backfilling pager_items.source from provider…");
  psql(`
    INSERT INTO sources (name, slug, type)
    SELECT DISTINCT provider, provider, 'pager'
    FROM pager_items
    WHERE provider IS NOT NULL AND provider <> ''
    ON CONFLICT (slug) DO NOTHING;

    -- A provider may already exist as a source created before the type column
    -- (type IS NULL); the INSERT above skips it (ON CONFLICT), so claim it as
    -- pager here — otherwise the FK backfill below matches nothing.
    UPDATE sources SET type = 'pager'
    WHERE type IS NULL
      AND slug IN (SELECT DISTINCT provider FROM pager_items WHERE provider IS NOT NULL AND provider <> '');

    UPDATE pager_items pi
    SET source = s.id
    FROM sources s
    WHERE s.slug = pi.provider AND s.type = 'pager' AND pi.source IS DISTINCT FROM s.id;
  `);
  console.log("Pager source backfill done.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Load a seed dataset, tolerating a missing file. The import functions already
// skip when their table is populated, and the schema/backfill work doesn't touch
// these files — so against an already-seeded Directus the data is unused, and the
// seed image needn't bake it in. A fresh full seed supplies the files via the
// *_DATA_PATH env vars (or by mounting them).
function loadJsonOrEmpty(path, label) {
  if (!existsSync(path)) {
    console.warn(`Seed data not found at ${path} — skipping ${label} import (schema + backfill still run).`);
    return [];
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const mediaRecords = loadJsonOrEmpty(MEDIA_DATA_PATH, "TV media");
const newsRecords  = loadJsonOrEmpty(NEWS_DATA_PATH, "news");
console.log(`Loaded ${mediaRecords.length} TV records, ${newsRecords.length} news records`);
const pagerRecords = loadJsonOrEmpty(PAGER_DATA_PATH, "pager");
console.log(`Loaded ${pagerRecords.length} pager records`);

const token = await getToken();
console.log("Authenticated.");

await createCollections(token);
await createRelations(token);
await ensurePublicBookmarkAccess(token);
createStreamerIndexes();

console.log("\n--- TV media items (entries_media.json) ---");
const sourceMap = await importSources(token, mediaRecords);
await importMediaItems(token, mediaRecords, sourceMap);

console.log("\n--- mp3 / Radio items (entries_media.json) ---");
await importMp3Items(token, mediaRecords, sourceMap);

console.log("\n--- News items (entries_news.json) ---");
const newsSourceId = await resolveNewsSource(token);
await importNewsItems(token, newsRecords, newsSourceId);

console.log("\n--- Pager items (pager_entries.json) ---");
await importPagerItems(token, pagerRecords);
await migratePagerSources(token);

console.log("\nBootstrap complete. Directus is at", DIRECTUS_URL);
